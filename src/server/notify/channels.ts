import nodemailer from 'nodemailer';
import { httpRequest } from '../../core/http';
import type { FieldDef, Runner } from '../../core';
import type { NetGuard } from '../../core';
import { trustOptions } from '../../core';

export interface Message {
  event: string;
  subject: string;
  text: string;
  html?: string;
  /** Flat variables available to templates, e.g. monitor.name. */
  vars: Record<string, string>;
}

export interface SendContext { guard: NetGuard; signal: AbortSignal }

export interface ChannelType {
  type: string;
  label: string;
  fields: FieldDef[];
  send(config: Record<string, any>, msg: Message, ctx: SendContext): Promise<void>;
}

/** {{path}} placeholder substitution; unknown keys render empty. */
export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => vars[k] ?? '');

async function post(url: string, ctx: SendContext, body: string, headers: Record<string, string>, method = 'POST'): Promise<void> {
  const res = await httpRequest({ url, method, headers, body, signal: ctx.signal, guard: ctx.guard, followRedirects: false, maxBodyBytes: 64 * 1024 });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
}
const json = (url: string, ctx: SendContext, payload: unknown, headers: Record<string, string> = {}) => post(url, ctx, JSON.stringify(payload), { 'content-type': 'application/json', ...headers });

const ACCENT: Record<string, number> = { down: 0xdc2626, up: 0x16a34a, flap: 0xd97706, cert: 0xd97706, test: 0x6366f1 };

const email: ChannelType = {
  type: 'email', label: 'Email (SMTP)',
  fields: [
    { key: 'host', label: 'SMTP host', kind: 'text', required: true },
    { key: 'port', label: 'Port', kind: 'number', default: 587, min: 1, max: 65535 },
    { key: 'security', label: 'Security', kind: 'select', options: [{ value: 'none', label: 'None' }, { value: 'starttls', label: 'STARTTLS' }, { value: 'ssl', label: 'SSL/TLS' }], default: 'starttls' },
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'from', label: 'From address', kind: 'text', required: true, placeholder: 'PulseWatch <alerts@example.com>' },
    { key: 'to', label: 'Recipients (comma separated)', kind: 'text', required: true },
  ],
  async send(c, msg, ctx) {
    await ctx.guard.resolve(c.host);
    const t = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.security === 'ssl', requireTLS: c.security === 'starttls', ignoreTLS: c.security === 'none',
      auth: c.username ? { user: c.username, pass: c.password } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      tls: trustOptions(),
    });
    try { await t.sendMail({ from: c.from, to: c.to, subject: msg.subject, text: msg.text, html: msg.html }); } finally { t.close(); }
  },
};

const telegram: ChannelType = {
  type: 'telegram', label: 'Telegram',
  fields: [
    { key: 'botToken', label: 'Bot token', kind: 'secret', required: true },
    { key: 'chatId', label: 'Chat ID', kind: 'text', required: true },
  ],
  send: (c, m, ctx) => json(`https://api.telegram.org/bot${c.botToken}/sendMessage`, ctx, { chat_id: c.chatId, text: `${m.subject}\n\n${m.text}`, disable_web_page_preview: true }),
};

const discord: ChannelType = {
  type: 'discord', label: 'Discord',
  fields: [{ key: 'webhookUrl', label: 'Webhook URL', kind: 'secret', required: true }],
  send: (c, m, ctx) => json(c.webhookUrl, ctx, { username: 'PulseWatch', embeds: [{ title: m.subject.slice(0, 250), description: m.text.slice(0, 3900), color: ACCENT[m.event] ?? 0x6366f1, url: m.vars.url, timestamp: new Date().toISOString() }] }),
};

const slack: ChannelType = {
  type: 'slack', label: 'Slack',
  fields: [{ key: 'webhookUrl', label: 'Incoming webhook URL', kind: 'secret', required: true }],
  send: (c, m, ctx) => json(c.webhookUrl, ctx, { text: `*${m.subject}*\n${m.text}` }),
};

const teams: ChannelType = {
  type: 'teams', label: 'Microsoft Teams',
  fields: [{ key: 'webhookUrl', label: 'Workflow / webhook URL', kind: 'secret', required: true }],
  send: (c, m, ctx) => json(c.webhookUrl, ctx, {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: m.subject, weight: 'Bolder', size: 'Medium', wrap: true }, { type: 'TextBlock', text: m.text, wrap: true }], actions: m.vars.url ? [{ type: 'Action.OpenUrl', title: 'Open', url: m.vars.url }] : [] } }],
  }),
};

const ntfy: ChannelType = {
  type: 'ntfy', label: 'ntfy',
  fields: [
    { key: 'server', label: 'Server', kind: 'text', default: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', kind: 'text', required: true },
    { key: 'token', label: 'Access token (optional)', kind: 'secret' },
    { key: 'priority', label: 'Priority (1-5)', kind: 'number', default: 4, min: 1, max: 5 },
  ],
  send: (c, m, ctx) => post(`${String(c.server || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(c.topic)}`, ctx, m.text, {
    Title: m.subject, Priority: String(m.event === 'up' ? 3 : c.priority ?? 4), Tags: m.event === 'up' ? 'white_check_mark' : m.event === 'down' ? 'rotating_light' : 'warning',
    ...(m.vars.url ? { Click: m.vars.url } : {}), ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
  }),
};

const gotify: ChannelType = {
  type: 'gotify', label: 'Gotify',
  fields: [
    { key: 'server', label: 'Server URL', kind: 'text', required: true },
    { key: 'token', label: 'App token', kind: 'secret', required: true },
    { key: 'priority', label: 'Priority', kind: 'number', default: 5, min: 0, max: 10 },
  ],
  send: (c, m, ctx) => json(`${String(c.server).replace(/\/$/, '')}/message`, ctx, { title: m.subject, message: m.text, priority: c.priority ?? 5 }, { 'X-Gotify-Key': c.token }),
};

const pushover: ChannelType = {
  type: 'pushover', label: 'Pushover',
  fields: [
    { key: 'appToken', label: 'Application token', kind: 'secret', required: true },
    { key: 'userKey', label: 'User / group key', kind: 'secret', required: true },
    { key: 'priority', label: 'Priority (-2..1)', kind: 'number', default: 0, min: -2, max: 1 },
  ],
  send: (c, m, ctx) => post('https://api.pushover.net/1/messages.json', ctx, new URLSearchParams({ token: c.appToken, user: c.userKey, title: m.subject, message: m.text, priority: String(c.priority ?? 0), ...(m.vars.url ? { url: m.vars.url } : {}) }).toString(), { 'content-type': 'application/x-www-form-urlencoded' }),
};

const webhook: ChannelType = {
  type: 'webhook', label: 'Generic webhook',
  fields: [
    { key: 'url', label: 'URL', kind: 'secret', required: true },
    { key: 'method', label: 'Method', kind: 'select', options: ['POST', 'PUT', 'PATCH', 'GET'].map((v) => ({ value: v, label: v })), default: 'POST' },
    { key: 'headers', label: 'Headers', kind: 'kv', secretValues: true },
    { key: 'bodyTemplate', label: 'Body template', kind: 'textarea', help: 'Placeholders: {{event}} {{subject}} {{text}} {{monitor.name}} {{monitor.type}} {{status}} {{message}} {{errorKind}} {{url}} {{time}} {{incident.id}}. Leave empty for a default JSON payload.' },
  ],
  async send(c, m, ctx) {
    const body = c.bodyTemplate ? render(c.bodyTemplate, { ...m.vars, event: m.event, subject: m.subject, text: m.text }) : JSON.stringify({ event: m.event, subject: m.subject, text: m.text, ...m.vars });
    const looksJson = body.trim().startsWith('{') || body.trim().startsWith('[');
    await post(c.url, ctx, c.method === 'GET' ? '' : body, { 'content-type': looksJson ? 'application/json' : 'text/plain', ...(c.headers ?? {}) }, c.method ?? 'POST');
  },
};

const registry = new Map<string, ChannelType>([email, telegram, discord, slack, teams, ntfy, gotify, pushover, webhook].map((c) => [c.type, c]));
export const channelTypes = registry;
/** Plugin interface: add a notification channel type at startup. */
export const registerChannelType = (c: ChannelType) => registry.set(c.type, c);

/** Channel types reuse the monitor field machinery (validation, secret masking); this adapts one to the Runner shape. */
export const channelRunner = (type: string): Runner => ({ type, label: type, category: 'channel', fields: registry.get(type)!.fields, run: async () => ({ ok: true }) });
