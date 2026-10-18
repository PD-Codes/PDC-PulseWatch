import { Client } from 'ldapts';
import * as oidc from 'openid-client';
import type { FieldDef, Runner } from '../../core';
import { config } from '../config';
import type { Ctx } from '../context';
import { decryptJson } from '../crypto';
import { bool } from '../db';

/* Provider config schemas reuse the monitor field machinery (validation + secret masking). */
const role = { key: 'defaultRole', label: 'Default role', kind: 'select', options: [{ value: 'viewer', label: 'Viewer' }, { value: 'editor', label: 'Editor' }], default: 'viewer' } as const satisfies FieldDef;
const OIDC_FIELDS: FieldDef[] = [
  { key: 'issuer', label: 'Issuer URL', kind: 'text', required: true, help: 'e.g. https://login.microsoftonline.com/<tenant>/v2.0, https://accounts.google.com or https://keycloak/realms/<realm>' },
  { key: 'clientId', label: 'Client ID', kind: 'text', required: true },
  { key: 'clientSecret', label: 'Client secret', kind: 'secret', required: true },
  { key: 'scopes', label: 'Scopes', kind: 'text', default: 'openid profile email' },
  { key: 'groupsClaim', label: 'Groups claim', kind: 'text', default: 'groups' },
  { key: 'adminGroups', label: 'Admin groups (comma separated)', kind: 'text' },
  { key: 'editorGroups', label: 'Editor groups (comma separated)', kind: 'text' },
  role,
  { key: 'autoCreate', label: 'Create users on first login', kind: 'bool', default: true },
  { key: 'allowInsecure', label: 'Allow http:// issuer (development only)', kind: 'bool', default: false },
];
const LDAP_FIELDS: FieldDef[] = [
  { key: 'url', label: 'Server URL', kind: 'text', required: true, help: 'ldaps://ldap.example.com:636 or ldap://host:389' },
  { key: 'startTls', label: 'Use StartTLS', kind: 'bool', default: false },
  { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
  { key: 'bindDn', label: 'Service account DN', kind: 'text' },
  { key: 'bindPassword', label: 'Service account password', kind: 'secret' },
  { key: 'baseDn', label: 'User base DN', kind: 'text', required: true },
  { key: 'userFilter', label: 'User filter', kind: 'text', default: '(uid={{username}})', help: 'Use (sAMAccountName={{username}}) for Active Directory' },
  { key: 'emailAttr', label: 'Email attribute', kind: 'text', default: 'mail' },
  { key: 'nameAttr', label: 'Display name attribute', kind: 'text', default: 'cn' },
  { key: 'adminGroupDn', label: 'Admin group DN (memberOf)', kind: 'text' },
  { key: 'editorGroupDn', label: 'Editor group DN (memberOf)', kind: 'text' },
  role,
];
export const providerRunner = (kind: 'oidc' | 'ldap'): Runner => ({ type: kind, label: kind, category: 'auth', fields: kind === 'oidc' ? OIDC_FIELDS : LDAP_FIELDS, run: async () => ({ ok: true }) });

type Role = 'admin' | 'editor' | 'viewer';
const csv = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Find or create the local record of an externally authenticated user. Returns null when the login must be refused. */
async function upsertExternal(ctx: Ctx, source: 'oidc' | 'ldap', externalId: string, p: { username: string; email?: string | null; displayName?: string; role?: Role; defaultRole: Role; create: boolean }): Promise<number | null> {
  const { db } = ctx;
  const existing = await db.selectFrom('users').selectAll().where('auth_source', '=', source).where('external_id', '=', externalId).executeTakeFirst();
  if (existing) {
    if (!bool(existing.is_active)) return null;
    await db.updateTable('users').set({ last_login_at: new Date(), ...(p.displayName ? { display_name: p.displayName } : {}), ...(p.role ? { role: p.role } : {}) }).where('id', '=', existing.id).execute();
    return existing.id;
  }
  if (!p.create) return null;
  // never merge into an account that exists under another source: that would allow account takeover through a looser IdP
  let username = p.username.slice(0, 60) || 'user';
  for (let i = 0; i < 50; i++) {
    const candidate = i ? `${username}-${i + 1}` : username;
    try {
      const r = await db.insertInto('users').values({ username: candidate, email: p.email ?? null, display_name: p.displayName || candidate, password_hash: null, role: p.role ?? p.defaultRole, auth_source: source, external_id: externalId, last_login_at: new Date() }).executeTakeFirstOrThrow();
      return Number(r.insertId);
    } catch (e: any) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      if (/email/i.test(e.message)) { p = { ...p, email: null }; i--; }
    }
  }
  return null;
}

/* ---------------------------------- LDAP ---------------------------------- */

const escFilter = (s: string) => s.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** undefined = no LDAP provider enabled, null = rejected, number = local user id. */
export async function ldapLogin(ctx: Ctx, username: string, password: string): Promise<number | null | undefined> {
  if (!password) return null; // an empty password would turn the bind into an anonymous (always successful) one
  const providers = await ctx.db.selectFrom('auth_providers').selectAll().where('kind', '=', 'ldap').where('enabled', '=', 1).execute();
  if (!providers.length) return undefined;
  for (const prov of providers) {
    const c = decryptJson<Record<string, any>>(prov.config_enc);
    const tls = { rejectUnauthorized: c.verifyTls !== false };
    const client = new Client({ url: c.url, tlsOptions: tls, connectTimeout: 5000, timeout: 10000 });
    try {
      if (c.startTls) await client.startTLS(tls);
      if (c.bindDn) await client.bind(c.bindDn, c.bindPassword ?? '');
      const filter = String(c.userFilter || '(uid={{username}})').replace(/\{\{\s*username\s*\}\}/g, escFilter(username));
      const { searchEntries } = await client.search(c.baseDn, { scope: 'sub', filter, attributes: ['dn', 'memberOf', c.emailAttr || 'mail', c.nameAttr || 'cn'], sizeLimit: 2 });
      if (searchEntries.length !== 1) continue; // unknown or ambiguous
      const entry = searchEntries[0];
      await client.unbind().catch(() => {});
      const userClient = new Client({ url: c.url, tlsOptions: tls, connectTimeout: 5000, timeout: 10000 });
      try { if (c.startTls) await userClient.startTLS(tls); await userClient.bind(entry.dn, password); } finally { await userClient.unbind().catch(() => {}); }
      const groups = ([] as string[]).concat((entry.memberOf as string | string[] | undefined) ?? []).map((g) => g.toLowerCase());
      const str = (v: unknown) => (Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v));
      const mapped: Role | undefined = c.adminGroupDn && groups.includes(String(c.adminGroupDn).toLowerCase()) ? 'admin' : c.editorGroupDn && groups.includes(String(c.editorGroupDn).toLowerCase()) ? 'editor' : c.adminGroupDn || c.editorGroupDn ? (c.defaultRole ?? 'viewer') : undefined;
      return await upsertExternal(ctx, 'ldap', entry.dn, { username, email: str(entry[c.emailAttr || 'mail']), displayName: str(entry[c.nameAttr || 'cn']), role: mapped, defaultRole: c.defaultRole ?? 'viewer', create: true });
    } catch (e) {
      ctx.log.info({ err: (e as Error).message, provider: prov.id }, 'LDAP login failed');
    } finally { await client.unbind().catch(() => {}); }
  }
  return null;
}

/* ----------------------------------- OIDC ---------------------------------- */

export const oidcRedirectUri = () => `${config.baseUrl}/api/auth/oidc/callback`;
const discovered = new Map<string, { cfg: oidc.Configuration; exp: number }>();

async function oidcConfig(providerId: number, c: Record<string, any>): Promise<oidc.Configuration> {
  const hit = discovered.get(`${providerId}:${c.issuer}:${c.clientId}`);
  if (hit && hit.exp > Date.now()) return hit.cfg;
  const cfg = await oidc.discovery(new URL(c.issuer), c.clientId, c.clientSecret, undefined, c.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
  discovered.set(`${providerId}:${c.issuer}:${c.clientId}`, { cfg, exp: Date.now() + 10 * 60_000 });
  return cfg;
}

export async function oidcStart(ctx: Ctx, providerId: number): Promise<{ url: string; state: { s: string; n: string; v: string; p: number } } | null> {
  const prov = await ctx.db.selectFrom('auth_providers').selectAll().where('id', '=', providerId).where('kind', '=', 'oidc').where('enabled', '=', 1).executeTakeFirst();
  if (!prov) return null;
  const c = decryptJson<Record<string, any>>(prov.config_enc);
  const cfg = await oidcConfig(prov.id, c);
  const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(cfg, { redirect_uri: oidcRedirectUri(), scope: c.scopes || 'openid profile email', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
  return { url: url.href, state: { s: state, n: nonce, v: verifier, p: prov.id } };
}

/** Completes the authorization code flow. Returns the local user id, or null when the login is refused. */
export async function oidcFinish(ctx: Ctx, currentUrl: URL, st: { s: string; n: string; v: string; p: number }): Promise<number | null> {
  const prov = await ctx.db.selectFrom('auth_providers').selectAll().where('id', '=', st.p).where('kind', '=', 'oidc').where('enabled', '=', 1).executeTakeFirst();
  if (!prov) return null;
  const c = decryptJson<Record<string, any>>(prov.config_enc);
  const cfg = await oidcConfig(prov.id, c);
  const tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, { pkceCodeVerifier: st.v, expectedState: st.s, expectedNonce: st.n, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims?.sub) return null;
  let info: Record<string, any> = { ...claims };
  // some providers (Google, Entra without optional claims) keep profile data at the userinfo endpoint
  if (!info.email || !info[c.groupsClaim || 'groups']) {
    try { info = { ...(await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub)), ...info }; } catch { /* userinfo is optional */ }
  }
  const groups = ([] as unknown[]).concat(info[c.groupsClaim || 'groups'] ?? []).map(String);
  const admin = csv(c.adminGroups), editor = csv(c.editorGroups);
  const mapped: Role | undefined = admin.some((g) => groups.includes(g)) ? 'admin' : editor.some((g) => groups.includes(g)) ? 'editor' : admin.length || editor.length ? (c.defaultRole ?? 'viewer') : undefined;
  if (info.email && info.email_verified === false) info.email = undefined; // never trust unverified addresses
  return upsertExternal(ctx, 'oidc', `${prov.id}:${claims.sub}`, {
    username: String(info.preferred_username ?? info.email ?? claims.sub).replace(/[^A-Za-z0-9._@-]/g, '_'), email: info.email as string | undefined, displayName: (info.name as string | undefined) ?? undefined,
    role: mapped, defaultRole: c.defaultRole ?? 'viewer', create: c.autoCreate !== false,
  });
}
