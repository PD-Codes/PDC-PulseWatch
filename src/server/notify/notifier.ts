import { sql } from 'kysely';
import { certNotice, describeTarget, type CheckResult } from '../../core';
import { config } from '../config';
import type { Ctx } from '../context';
import { decryptJson, encryptJson } from '../crypto';
import { bool, parseJson, type Database } from '../db';
import type { Monitor } from '../monitors/model';
import { isSnoozed } from '../alerts';
import { channelTypes, render, type Message } from './channels';
import { fill, notifyLang, TEXTS, type Lang } from './texts';

export type NotifyEvent = 'down' | 'up' | 'flap' | 'cert' | 'slo' | 'test';

export interface NotifyInput {
  event: NotifyEvent; monitor: Monitor; result?: CheckResult; incidentId?: number;
  /** event 'slo': where the monitor stands against its 30-day target. */
  slo?: { target: number; uptime30d: number | null; budgetMinutes: number; usedMinutes: number };
}

interface QuietHours { start: string; end: string; timezone?: string; days?: number[]; mode?: 'defer' | 'drop'; bypassDown?: boolean }
interface PolicyStep { delayMin: number; channelIds: number[] }
interface Policy { steps: PolicyStep[]; repeatEveryMin?: number }

export const BACKOFF_S = [30, 120, 600, 1800];
export const MAX_ATTEMPTS = 5;
/** Only outages and recoveries have to arrive in order; every other message goes out on its own. */
const CHAIN_EVENTS = ['down', 'up'];

/** Is `now` inside the quiet window? Returns the end of the window when it is. */
export function quietUntil(q: QuietHours | null, now = new Date()): Date | null {
  if (!q?.start || !q.end) return null;
  const tz = q.timezone || 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now); } catch { return null; } // an unknown zone must not block delivery
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const cur = Number(get('hour')) % 24 * 60 + Number(get('minute'));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  if (q.days?.length && !q.days.includes(day)) return null;
  const s = mins(q.start), e = mins(q.end);
  const inside = s <= e ? cur >= s && cur < e : cur >= s || cur < e;
  if (!inside) return null;
  const remaining = ((e - cur + 1440) % 1440) || 1440;
  return new Date(now.getTime() + remaining * 60_000);
}

/** Where deliveries are written: the pool, or the transaction that also marks the engine's outbox entry as done. */
export interface NotifyOpts { db?: Database; lang?: Lang }

type Delivery = { id: number; channel_id: number | null; monitor_id: number | null; event: string; attempts: number; payload: string | null; next_attempt_at: Date | null };

export class Notifier {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private current: Promise<void> = Promise.resolve();
  constructor(private ctx: Ctx) {}

  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.process(), 3000);
    this.timer.unref();
  }
  /** Stop picking up work and wait (bounded) for the deliveries in flight, so a shutdown does not cut one off and send it again later. */
  async stop(waitMs = 0): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    let t: NodeJS.Timeout | undefined;
    await Promise.race([this.current, new Promise((r) => { t = setTimeout(r, waitMs); })]);
    clearTimeout(t);
  }
  /** Look for due deliveries soon (after new ones were committed). */
  kick() { if (!this.stopped) setImmediate(() => void this.process()); }

  private vars(i: NotifyInput): Record<string, string> {
    const m = i.monitor;
    const r = i.result;
    return {
      'monitor.name': m.name, 'monitor.type': m.type, 'monitor.id': String(m.id),
      status: i.event === 'up' ? 'UP' : i.event === 'down' ? 'DOWN' : i.event.toUpperCase(),
      message: r?.message ?? '', target: describeTarget(m.config) ?? '', errorKind: r?.errorKind ?? '', latency: r?.latencyMs != null ? `${r.latencyMs} ms` : '',
      url: `${config.baseUrl}/monitors/${m.id}`, time: new Date().toISOString(), 'incident.id': i.incidentId ? String(i.incidentId) : '',
    };
  }

  /** Default human readable message; a channel template may override subject/body. */
  buildMessage(i: NotifyInput, tpl?: { subject: string; body: string } | null, lang: Lang = 'en'): Message {
    const v = this.vars(i);
    const name = i.monitor.name;
    const T = TEXTS[lang];
    const tag = `[${T.tag[i.event] ?? i.event.toUpperCase()}] ${name}`;
    let subject: string, text: string;
    switch (i.event) {
      case 'down': subject = tag; text = `${fill(T.down, { name })}${v.target ? `\n${fill(T.target, { v: v.target })}` : ''}\n${fill(T.reason, { v: v.message || T.unknown })}${v.errorKind ? ` (${v.errorKind})` : ''}\n${v.url}`; break;
      case 'up': subject = tag; text = `${fill(T.up, { name })}${v.latency ? `\n${fill(T.latency, { v: v.latency })}` : ''}\n${v.url}`; break;
      case 'flap': subject = tag; text = `${fill(T.flap, { name })}\n${v.url}`; break;
      case 'cert': subject = tag; text = `${i.result?.cert ? certNotice(i.result.cert, i.monitor.config, lang) : v.message}\n${v.url}`; break;
      case 'slo': {
        const s = i.slo;
        subject = tag; text = `${fill(T.slo, { name, uptime: s?.uptime30d ?? T.na, target: s?.target ?? '' })}${s ? `\n${fill(T.sloBudget, { used: s.usedMinutes, budget: s.budgetMinutes })}` : ''}\n${v.url}`;
        break;
      }
      default: subject = tag; text = `${fill(T.test, { brand: config.brand.name })}\n${v.url}`;
    }
    if (tpl) { subject = render(tpl.subject, { ...v, event: i.event }); text = render(tpl.body, { ...v, event: i.event }); }
    const html = `<p><strong>${escapeHtml(subject)}</strong></p><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    return { event: i.event, subject, text, html, vars: v };
  }

  /**
   * Resolve the monitor's rules (or the default channels) and queue deliveries. With `opts.db` set to a transaction everything
   * is written there (and `lang` should be given, so no second connection is needed); the caller then kicks the worker after the commit.
   */
  async notify(i: NotifyInput, opts: NotifyOpts = {}): Promise<number> {
    const db = opts.db ?? this.ctx.db;
    // a snoozed monitor sends nothing (and starts no escalation); checks, events and incidents go on
    if (i.event !== 'test' && (await isSnoozed(db, i.monitor.id))) return 0;
    const lang = opts.lang ?? (await notifyLang(this.ctx)).lang;
    const rules = await db.selectFrom('monitor_notifications').selectAll().where('monitor_id', '=', i.monitor.id).execute();
    const channelIds = new Set<number>();
    for (const r of rules) {
      const events = r.events.split(',');
      // an SLO miss goes where outages go, unless a rule asks for it by name
      if (!events.includes(i.event) && !(i.event === 'slo' && events.includes('down'))) continue;
      if (r.channel_id) channelIds.add(r.channel_id);
      if (r.policy_id && i.event === 'down' && i.incidentId) await this.startEscalation(i, r.policy_id, db);
    }
    if (!rules.length) for (const c of await db.selectFrom('notification_channels').select('id').where('is_default', '=', 1).where('active', '=', 1).execute()) channelIds.add(c.id);
    for (const id of channelIds) await this.queue(id, i, { db, lang });
    if (channelIds.size && !opts.db) this.kick();
    return channelIds.size;
  }

  async queue(channelId: number, i: NotifyInput, opts: { force?: boolean } & NotifyOpts = {}): Promise<void> {
    const db = opts.db ?? this.ctx.db;
    const ch = await db.selectFrom('notification_channels').selectAll().where('id', '=', channelId).executeTakeFirst();
    if (!ch || (!bool(ch.active) && !opts.force)) return;
    const tpl = ch.template_id ? await db.selectFrom('notification_templates').select(['subject', 'body']).where('id', '=', ch.template_id).executeTakeFirst() : null;
    const msg = this.buildMessage(i, tpl, opts.lang ?? (await notifyLang(this.ctx)).lang);
    let due = new Date();
    let status: 'pending' | 'skipped' = 'pending';
    let note: string | null = null;
    const q = quietUntil(parseJson<QuietHours | null>(ch.quiet_hours, null));
    if (q && !opts.force) {
      const qh = parseJson<QuietHours>(ch.quiet_hours, {} as QuietHours);
      if (qh.bypassDown && i.event === 'down') note = null;
      else if (qh.mode === 'drop') { status = 'skipped'; note = 'Dropped during quiet hours'; }
      else { due = q; note = 'Deferred until quiet hours end'; }
    }
    await db.insertInto('notification_deliveries').values({
      channel_id: channelId, monitor_id: i.monitor.id, incident_id: i.incidentId ?? null, event: i.event, status, next_attempt_at: status === 'pending' ? due : null,
      last_error: note, subject: msg.subject.slice(0, 255), payload: JSON.stringify(msg),
    }).execute();
  }

  /* ---------------- escalation policies ---------------- */
  private async startEscalation(i: NotifyInput, policyId: number, db: Database = this.ctx.db) {
    const pol = await db.selectFrom('escalation_policies').select('steps').where('id', '=', policyId).executeTakeFirst();
    const steps = parseJson<Policy>(pol?.steps ?? null, { steps: [] }).steps;
    if (!steps.length) return;
    const exists = await db.selectFrom('escalation_runs').select(['id', 'active']).where('incident_id', '=', i.incidentId!).where('policy_id', '=', policyId).executeTakeFirst();
    if (exists) {
      // a run that was stopped (incident set to monitoring) starts over when the monitor fails again
      if (!exists.active) await db.updateTable('escalation_runs').set({ active: 1, next_step: 0, next_at: new Date(Date.now() + steps[0].delayMin * 60_000) }).where('id', '=', exists.id).where('active', '=', 0).execute();
      return;
    }
    await db.insertInto('escalation_runs').values({ incident_id: i.incidentId!, monitor_id: i.monitor.id, policy_id: policyId, next_step: 0, next_at: new Date(Date.now() + steps[0].delayMin * 60_000) }).execute();
  }

  private async runEscalations() {
    const { db } = this.ctx;
    const due = await db.selectFrom('escalation_runs').selectAll().where('active', '=', 1).where('next_at', '<=', sql<Date>`NOW(3)`).limit(20).execute();
    for (const run of due) {
      const claimed = await db.updateTable('escalation_runs').set({ next_at: sql<Date>`DATE_ADD(NOW(3), INTERVAL 5 MINUTE)` }).where('id', '=', run.id).where('next_at', '=', run.next_at).executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1) continue;
      // a snoozed monitor's escalation waits for the end of the snooze
      const snoozed = await isSnoozed(db, run.monitor_id);
      if (snoozed) { await db.updateTable('escalation_runs').set({ next_at: snoozed }).where('id', '=', run.id).execute(); continue; }
      const inc = await db.selectFrom('incidents').select(['status']).where('id', '=', run.incident_id).executeTakeFirst();
      if (!inc || inc.status !== 'open') { await db.updateTable('escalation_runs').set({ active: 0 }).where('id', '=', run.id).execute(); continue; }
      const pol = await db.selectFrom('escalation_policies').select('steps').where('id', '=', run.policy_id).executeTakeFirst();
      const policy = parseJson<Policy>(pol?.steps ?? null, { steps: [] });
      const step = policy.steps[run.next_step];
      const mrow = await db.selectFrom('monitors').selectAll().where('id', '=', run.monitor_id).executeTakeFirst();
      if (!step || !mrow) { await db.updateTable('escalation_runs').set({ active: 0 }).where('id', '=', run.id).execute(); continue; }
      const { parseMonitor } = await import('../monitors/model');
      const st = await db.selectFrom('monitor_state').select(['last_message', 'last_error_kind']).where('monitor_id', '=', run.monitor_id).executeTakeFirst();
      const lang = (await notifyLang(this.ctx)).lang;
      const input: NotifyInput = { event: 'down', monitor: parseMonitor(mrow), incidentId: run.incident_id, result: { ok: false, message: fill(TEXTS[lang].escalation, { n: run.next_step + 1, msg: st?.last_message ?? TEXTS[lang].stillDown }), errorKind: (st?.last_error_kind ?? undefined) as any } };
      for (const cid of step.channelIds) await this.queue(cid, input);
      const next = policy.steps[run.next_step + 1];
      if (next) await db.updateTable('escalation_runs').set({ next_step: run.next_step + 1, next_at: new Date(Date.now() + next.delayMin * 60_000) }).where('id', '=', run.id).execute();
      else if (policy.repeatEveryMin) await db.updateTable('escalation_runs').set({ next_step: 0, next_at: new Date(Date.now() + policy.repeatEveryMin * 60_000) }).where('id', '=', run.id).execute();
      else await db.updateTable('escalation_runs').set({ active: 0 }).where('id', '=', run.id).execute();
    }
  }

  /* ---------------- delivery worker ---------------- */
  /** One pass of the worker; while a pass is running, callers wait for that one. */
  async process(): Promise<void> {
    if (this.busy) return this.current;
    if (this.stopped) return;
    this.busy = true;
    const run = this.processOnce();
    this.current = run;
    try { await run; } finally { this.busy = false; }
  }

  private async processOnce(): Promise<void> {
    try {
      await this.runEscalations();
      const { db } = this.ctx;
      // Everything except DOWN/UP goes out on its own: a rejected certificate notice must not hold back an outage, nor wait for one.
      const loose = await db.selectFrom('notification_deliveries').select(['id', 'channel_id', 'monitor_id', 'event', 'attempts', 'payload', 'next_attempt_at'])
        .where('status', '=', 'pending').where('next_attempt_at', '<=', sql<Date>`NOW(3)`)
        .where((eb) => eb.or([eb('event', 'not in', CHAIN_EVENTS), eb('monitor_id', 'is', null), eb('channel_id', 'is', null)]))
        .orderBy('id').limit(200).execute();
      // DOWN and UP of one channel and monitor form a chain that goes out strictly in event order: a DOWN in backoff or deferred
      // by quiet hours must not arrive after the UP that followed it. Only the head of each chain is read (MIN(id) per chain).
      const heads = await db.selectFrom('notification_deliveries as d')
        .innerJoin((eb) => eb.selectFrom('notification_deliveries').select((e) => e.fn.min('id').as('head')).where('status', '=', 'pending').where('event', 'in', CHAIN_EVENTS)
          .where('monitor_id', 'is not', null).where('channel_id', 'is not', null).groupBy(['monitor_id', 'channel_id']).as('h'), (j) => j.onRef('h.head', '=', 'd.id'))
        .select(['d.id', 'd.channel_id', 'd.monitor_id', 'd.event', 'd.attempts', 'd.payload', 'd.next_attempt_at']).orderBy('d.id').execute();
      const now = Date.now();
      const isDue = (d: Delivery) => d.next_attempt_at != null && d.next_attempt_at.getTime() <= now;
      // a head that waits only matters when something behind it is due (an UP that supersedes it, a DOWN that bypasses quiet hours)
      const waiting = heads.filter((h) => !isDue(h));
      const dueBehind = new Set<string>();
      if (waiting.length) {
        for (const r of await db.selectFrom('notification_deliveries').select(['channel_id', 'monitor_id']).where('status', '=', 'pending').where('event', 'in', CHAIN_EVENTS)
          .where('next_attempt_at', '<=', sql<Date>`NOW(3)`).where('monitor_id', 'in', [...new Set(waiting.map((h) => h.monitor_id!))]).groupBy(['monitor_id', 'channel_id']).execute()) dueBehind.add(`${r.channel_id}:${r.monitor_id}`);
      }
      const chains = heads.filter((h) => isDue(h) || dueBehind.has(`${h.channel_id}:${h.monitor_id}`)).slice(0, 200);
      await Promise.all([...loose.map((d) => this.deliver(d)), ...chains.map((h) => this.runChain(h))]);
    } catch (e) { this.ctx.log.error({ err: e }, 'notification worker failed'); }
  }

  /** Walk one DOWN/UP chain from its head: drop what is outdated, send what is due, stop at the first delivery that has to wait or fails. */
  private async runChain(head: Delivery): Promise<void> {
    const { db } = this.ctx;
    const chain = () => db.selectFrom('notification_deliveries').select(['id', 'channel_id', 'monitor_id', 'event', 'attempts', 'payload', 'next_attempt_at'])
      .where('monitor_id', '=', head.monitor_id!).where('channel_id', '=', head.channel_id!).where('event', 'in', CHAIN_EVENTS);
    let d: Delivery | undefined = head;
    for (let n = 0; d && n < 50 && !this.stopped; n++) {
      const due = d.next_attempt_at != null && d.next_attempt_at.getTime() <= Date.now();
      // an outage that has not reached the channel yet is old news once the recovery exists (also one dropped in quiet hours)
      if (d.event === 'down' && (await chain().select('id').where('status', 'in', ['pending', 'skipped']).where('event', '=', 'up').where('id', '>', d.id).limit(1).executeTakeFirst())) await this.skip(d, 'Superseded by a later recovery');
      // an unsent recovery that would hold back a newer outage (quiet hours with "bypass for DOWN") is dropped instead
      else if (d.event === 'up' && !due && (await chain().select('id').where('status', '=', 'pending').where('event', '=', 'down').where('id', '>', d.id).where('next_attempt_at', '<=', sql<Date>`NOW(3)`).limit(1).executeTakeFirst())) await this.skip(d, 'Superseded by a later outage');
      else if (!due || !(await this.deliver(d))) return;
      d = await chain().where('status', '=', 'pending').orderBy('id').limit(1).executeTakeFirst();
    }
  }

  private async skip(d: Delivery, why: string): Promise<void> {
    await this.ctx.db.updateTable('notification_deliveries').set({ status: 'skipped', next_attempt_at: null, last_error: why }).where('id', '=', d.id).where('status', '=', 'pending').execute();
  }

  /** Claim and send one delivery. True when it is done (sent), false when it failed, waits for a retry or another process has it. */
  private async deliver(d: Delivery): Promise<boolean> {
    const { db, log } = this.ctx;
    const claim = await db.updateTable('notification_deliveries').set({ next_attempt_at: sql<Date>`DATE_ADD(NOW(3), INTERVAL 2 MINUTE)` }).where('id', '=', d.id).where('status', '=', 'pending').where('next_attempt_at', '=', d.next_attempt_at).executeTakeFirst();
    if (Number(claim.numUpdatedRows) !== 1) return false;
    try {
      await this.send(d.channel_id!, parseJson<Message>(d.payload, null as any));
      await db.updateTable('notification_deliveries').set({ status: 'sent', attempts: d.attempts + 1, next_attempt_at: null, last_error: null }).where('id', '=', d.id).execute();
      return true;
    } catch (e) {
      const attempts = d.attempts + 1;
      const msg = (e as Error).message.slice(0, 900);
      log.warn({ delivery: d.id, err: msg }, 'notification delivery failed');
      if (attempts >= MAX_ATTEMPTS) {
        await db.updateTable('notification_deliveries').set({ status: 'failed', attempts, next_attempt_at: null, last_error: msg }).where('id', '=', d.id).execute();
        return true; // given up: the next message of the chain may go
      }
      await db.updateTable('notification_deliveries').set({ attempts, last_error: msg, next_attempt_at: new Date(Date.now() + BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000) }).where('id', '=', d.id).execute();
      return false;
    }
  }

  /** Send a message through a stored channel right now (also used by the test button). */
  async send(channelId: number, msg: Message): Promise<void> {
    const ch = await this.ctx.db.selectFrom('notification_channels').selectAll().where('id', '=', channelId).executeTakeFirst();
    if (!ch) throw new Error('Channel no longer exists');
    const type = channelTypes.get(ch.type);
    if (!type) throw new Error(`Unknown channel type ${ch.type}`);
    await type.send(decryptJson(ch.config_enc), msg, { guard: this.ctx.guard, signal: AbortSignal.timeout(20_000) });
  }

  /** Test button: sends immediately and records the attempt in the delivery log. */
  async test(channelId: number, monitor: Monitor): Promise<{ ok: boolean; error?: string }> {
    const input: NotifyInput = { event: 'test', monitor };
    const msg = this.buildMessage(input, null, (await notifyLang(this.ctx)).lang);
    let error: string | undefined;
    try { await this.send(channelId, msg); } catch (e) { error = (e as Error).message; }
    await this.ctx.db.insertInto('notification_deliveries').values({ channel_id: channelId, monitor_id: null, event: 'test', status: error ? 'failed' : 'sent', attempts: 1, last_error: error?.slice(0, 900) ?? null, subject: msg.subject.slice(0, 255), payload: JSON.stringify(msg) }).execute();
    return error ? { ok: false, error } : { ok: true };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export { encryptJson };
