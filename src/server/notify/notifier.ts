import { sql } from 'kysely';
import type { CheckResult } from '../../core';
import { config } from '../config';
import type { Ctx } from '../context';
import { decryptJson, encryptJson } from '../crypto';
import { bool, parseJson } from '../db';
import type { Monitor } from '../monitors/model';
import { channelTypes, render, type Message } from './channels';

export type NotifyEvent = 'down' | 'up' | 'flap' | 'cert' | 'test';

export interface NotifyInput { event: NotifyEvent; monitor: Monitor; result?: CheckResult; incidentId?: number }

interface QuietHours { start: string; end: string; timezone?: string; days?: number[]; mode?: 'defer' | 'drop'; bypassDown?: boolean }
interface PolicyStep { delayMin: number; channelIds: number[] }
interface Policy { steps: PolicyStep[]; repeatEveryMin?: number }

const BACKOFF_S = [30, 120, 600, 1800];
const MAX_ATTEMPTS = 5;

/** Is `now` inside the quiet window? Returns the end of the window when it is. */
export function quietUntil(q: QuietHours | null, now = new Date()): Date | null {
  if (!q?.start || !q.end) return null;
  const tz = q.timezone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now);
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

export class Notifier {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private ctx: Ctx) {}

  start() {
    this.timer = setInterval(() => void this.process(), 3000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  private vars(i: NotifyInput): Record<string, string> {
    const m = i.monitor;
    const r = i.result;
    return {
      'monitor.name': m.name, 'monitor.type': m.type, 'monitor.id': String(m.id),
      status: i.event === 'up' ? 'UP' : i.event === 'down' ? 'DOWN' : i.event.toUpperCase(),
      message: r?.message ?? '', errorKind: r?.errorKind ?? '', latency: r?.latencyMs != null ? `${r.latencyMs} ms` : '',
      url: `${config.baseUrl}/monitors/${m.id}`, time: new Date().toISOString(), 'incident.id': i.incidentId ? String(i.incidentId) : '',
    };
  }

  /** Default human readable message; a channel template may override subject/body. */
  buildMessage(i: NotifyInput, tpl?: { subject: string; body: string } | null): Message {
    const v = this.vars(i);
    const name = i.monitor.name;
    let subject: string, text: string;
    switch (i.event) {
      case 'down': subject = `[DOWN] ${name}`; text = `${name} is down.\nReason: ${v.message || 'unknown'}${v.errorKind ? ` (${v.errorKind})` : ''}\n${v.url}`; break;
      case 'up': subject = `[UP] ${name}`; text = `${name} is back up.${v.latency ? `\nResponse time: ${v.latency}` : ''}\n${v.url}`; break;
      case 'flap': subject = `[FLAPPING] ${name}`; text = `${name} keeps changing state. Alerts are muted until it is stable again.\n${v.url}`; break;
      case 'cert': subject = `[CERTIFICATE] ${name}`; text = `${v.message}\n${v.url}`; break;
      default: subject = `[TEST] ${name}`; text = `This is a test notification from ${config.brand.name}.\n${v.url}`;
    }
    if (tpl) { subject = render(tpl.subject, { ...v, event: i.event }); text = render(tpl.body, { ...v, event: i.event }); }
    const html = `<p><strong>${escapeHtml(subject)}</strong></p><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    return { event: i.event, subject, text, html, vars: v };
  }

  /** Resolve the monitor's rules (or the default channels) and queue deliveries. */
  async notify(i: NotifyInput): Promise<void> {
    const { db } = this.ctx;
    const rules = await db.selectFrom('monitor_notifications').selectAll().where('monitor_id', '=', i.monitor.id).execute();
    const channelIds = new Set<number>();
    for (const r of rules) {
      if (!r.events.split(',').includes(i.event)) continue;
      if (r.channel_id) channelIds.add(r.channel_id);
      if (r.policy_id && i.event === 'down' && i.incidentId) await this.startEscalation(i, r.policy_id);
    }
    if (!rules.length) for (const c of await db.selectFrom('notification_channels').select('id').where('is_default', '=', 1).where('active', '=', 1).execute()) channelIds.add(c.id);
    for (const id of channelIds) await this.queue(id, i);
    if (channelIds.size) setImmediate(() => void this.process());
  }

  async queue(channelId: number, i: NotifyInput, opts: { force?: boolean } = {}): Promise<void> {
    const { db } = this.ctx;
    const ch = await db.selectFrom('notification_channels').selectAll().where('id', '=', channelId).executeTakeFirst();
    if (!ch || (!bool(ch.active) && !opts.force)) return;
    const tpl = ch.template_id ? await db.selectFrom('notification_templates').select(['subject', 'body']).where('id', '=', ch.template_id).executeTakeFirst() : null;
    const msg = this.buildMessage(i, tpl);
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
      last_error: note, subject: msg.subject, payload: JSON.stringify(msg),
    }).execute();
  }

  /* ---------------- escalation policies ---------------- */
  private async startEscalation(i: NotifyInput, policyId: number) {
    const { db } = this.ctx;
    const pol = await db.selectFrom('escalation_policies').select('steps').where('id', '=', policyId).executeTakeFirst();
    const steps = parseJson<Policy>(pol?.steps ?? null, { steps: [] }).steps;
    if (!steps.length) return;
    const exists = await db.selectFrom('escalation_runs').select('id').where('incident_id', '=', i.incidentId!).where('policy_id', '=', policyId).executeTakeFirst();
    if (exists) return;
    await db.insertInto('escalation_runs').values({ incident_id: i.incidentId!, monitor_id: i.monitor.id, policy_id: policyId, next_step: 0, next_at: new Date(Date.now() + steps[0].delayMin * 60_000) }).execute();
  }

  private async runEscalations() {
    const { db } = this.ctx;
    const due = await db.selectFrom('escalation_runs').selectAll().where('active', '=', 1).where('next_at', '<=', sql<Date>`NOW(3)`).limit(20).execute();
    for (const run of due) {
      const claimed = await db.updateTable('escalation_runs').set({ next_at: sql<Date>`DATE_ADD(NOW(3), INTERVAL 5 MINUTE)` }).where('id', '=', run.id).where('next_at', '=', run.next_at).executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1) continue;
      const inc = await db.selectFrom('incidents').select(['status']).where('id', '=', run.incident_id).executeTakeFirst();
      if (!inc || inc.status !== 'open') { await db.updateTable('escalation_runs').set({ active: 0 }).where('id', '=', run.id).execute(); continue; }
      const pol = await db.selectFrom('escalation_policies').select('steps').where('id', '=', run.policy_id).executeTakeFirst();
      const policy = parseJson<Policy>(pol?.steps ?? null, { steps: [] });
      const step = policy.steps[run.next_step];
      const mrow = await db.selectFrom('monitors').selectAll().where('id', '=', run.monitor_id).executeTakeFirst();
      if (!step || !mrow) { await db.updateTable('escalation_runs').set({ active: 0 }).where('id', '=', run.id).execute(); continue; }
      const { parseMonitor } = await import('../monitors/model');
      const st = await db.selectFrom('monitor_state').select(['last_message', 'last_error_kind']).where('monitor_id', '=', run.monitor_id).executeTakeFirst();
      const input: NotifyInput = { event: 'down', monitor: parseMonitor(mrow), incidentId: run.incident_id, result: { ok: false, message: `Escalation step ${run.next_step + 1}: ${st?.last_message ?? 'monitor is still down'}`, errorKind: (st?.last_error_kind ?? undefined) as any } };
      for (const cid of step.channelIds) await this.queue(cid, input);
      const next = policy.steps[run.next_step + 1];
      if (next) await db.updateTable('escalation_runs').set({ next_step: run.next_step + 1, next_at: new Date(Date.now() + next.delayMin * 60_000) }).where('id', '=', run.id).execute();
      else if (policy.repeatEveryMin) await db.updateTable('escalation_runs').set({ next_step: 0, next_at: new Date(Date.now() + policy.repeatEveryMin * 60_000) }).where('id', '=', run.id).execute();
      else await db.updateTable('escalation_runs').set({ active: 0 }).where('id', '=', run.id).execute();
    }
  }

  /* ---------------- delivery worker ---------------- */
  async process(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.runEscalations();
      const { db } = this.ctx;
      const due = await db.selectFrom('notification_deliveries').selectAll().where('status', '=', 'pending').where('next_attempt_at', '<=', sql<Date>`NOW(3)`).orderBy('id').limit(50).execute();
      await Promise.all(due.map((d) => this.deliver(d)));
    } catch (e) { this.ctx.log.error({ err: e }, 'notification worker failed'); } finally { this.busy = false; }
  }

  private async deliver(d: { id: number; channel_id: number | null; attempts: number; payload: string | null; next_attempt_at: Date | null }): Promise<void> {
    const { db, log } = this.ctx;
    const claim = await db.updateTable('notification_deliveries').set({ next_attempt_at: sql<Date>`DATE_ADD(NOW(3), INTERVAL 2 MINUTE)` }).where('id', '=', d.id).where('status', '=', 'pending').where('next_attempt_at', '=', d.next_attempt_at).executeTakeFirst();
    if (Number(claim.numUpdatedRows) !== 1) return;
    try {
      await this.send(d.channel_id!, parseJson<Message>(d.payload, null as any));
      await db.updateTable('notification_deliveries').set({ status: 'sent', attempts: d.attempts + 1, next_attempt_at: null, last_error: null }).where('id', '=', d.id).execute();
    } catch (e) {
      const attempts = d.attempts + 1;
      const msg = (e as Error).message.slice(0, 900);
      log.warn({ delivery: d.id, err: msg }, 'notification delivery failed');
      if (attempts >= MAX_ATTEMPTS) await db.updateTable('notification_deliveries').set({ status: 'failed', attempts, next_attempt_at: null, last_error: msg }).where('id', '=', d.id).execute();
      else await db.updateTable('notification_deliveries').set({ attempts, last_error: msg, next_attempt_at: new Date(Date.now() + BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000) }).where('id', '=', d.id).execute();
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
    const msg = this.buildMessage(input);
    let error: string | undefined;
    try { await this.send(channelId, msg); } catch (e) { error = (e as Error).message; }
    await this.ctx.db.insertInto('notification_deliveries').values({ channel_id: channelId, monitor_id: null, event: 'test', status: error ? 'failed' : 'sent', attempts: 1, last_error: error?.slice(0, 900) ?? null, subject: msg.subject, payload: JSON.stringify(msg) }).execute();
    return error ? { ok: false, error } : { ok: true };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export { encryptJson };
