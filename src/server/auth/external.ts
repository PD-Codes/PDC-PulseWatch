import crypto from 'node:crypto';
import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import { Client } from 'ldapts';
import * as oidc from 'openid-client';
import { trustOptions, type FieldDef, type Runner } from '../../core';
import { config } from '../config';
import type { Ctx } from '../context';
import { decryptJson, safeEqual } from '../crypto';
import { bool } from '../db';

/* Provider config schemas reuse the monitor field machinery (validation + secret masking). */
const role = { key: 'defaultRole', label: 'Default role', kind: 'select', options: [{ value: 'viewer', label: 'Viewer' }, { value: 'editor', label: 'Editor' }], default: 'viewer' } as const satisfies FieldDef;
const allowedGroups = { key: 'allowedGroups', label: 'Allowed groups (comma separated)', kind: 'text', help: 'Only members of these groups (or of the admin/editor groups below) may sign in. Leave empty to let everyone through. Everyone else is sent to the public status page, or sees a "no access" notice.' } as const satisfies FieldDef;
const OIDC_FIELDS: FieldDef[] = [
  { key: 'issuer', label: 'Issuer URL', kind: 'text', required: true, help: 'e.g. https://login.microsoftonline.com/<tenant>/v2.0, https://accounts.google.com or https://keycloak/realms/<realm>' },
  { key: 'clientId', label: 'Client ID', kind: 'text', required: true },
  { key: 'clientSecret', label: 'Client secret', kind: 'secret', required: true },
  { key: 'scopes', label: 'Scopes', kind: 'text', default: 'openid profile email' },
  { key: 'groupsClaim', label: 'Groups claim', kind: 'text', default: 'groups' },
  allowedGroups,
  { key: 'adminGroups', label: 'Admin groups (comma separated)', kind: 'text' },
  { key: 'editorGroups', label: 'Editor groups (comma separated)', kind: 'text' },
  role,
  { key: 'autoCreate', label: 'Create users on first login', kind: 'bool', default: false, help: 'Off by default: anyone who can sign in at the identity provider would otherwise get an account. Turn on only for a restricted provider (own tenant, allowed domains).' },
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
  { key: 'allowedGroupDns', label: 'Allowed groups (DN, one per line)', kind: 'textarea', help: 'Only members of these groups (or of the admin/editor groups below) may sign in. Leave empty to let every directory user through. Everyone else is sent to the public status page, or sees a "no access" notice.' },
  { key: 'adminGroupDn', label: 'Admin group DN (memberOf)', kind: 'text' },
  { key: 'editorGroupDn', label: 'Editor group DN (memberOf)', kind: 'text' },
  role,
];
// Defaults match the claim URIs Microsoft Entra ID sends in SAML assertions.
const SAML_FIELDS: FieldDef[] = [
  { key: 'entryPoint', label: 'IdP sign-on URL', kind: 'text', required: true, help: 'Entra ID: "Login URL" from the SAML certificates and setup section of the enterprise application.' },
  { key: 'idpIssuer', label: 'IdP entity ID (optional)', kind: 'text', help: 'Entra ID: "Microsoft Entra Identifier". When set, assertions from any other issuer are rejected.' },
  { key: 'idpCert', label: 'IdP signing certificate (PEM)', kind: 'textarea', required: true, help: 'Entra ID: download "Certificate (Base64)". Paste several certificates to support key rollover.' },
  { key: 'spEntityId', label: 'SP entity ID (optional)', kind: 'text', help: 'Defaults to the metadata URL of this provider. Must match the identifier configured at the IdP.' },
  { key: 'emailAttr', label: 'Email attribute', kind: 'text', default: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' },
  { key: 'nameAttr', label: 'Display name attribute', kind: 'text', default: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name' },
  { key: 'groupsAttr', label: 'Groups attribute', kind: 'text', default: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', help: 'Entra ID sends group object IDs unless the claim is configured otherwise.' },
  allowedGroups,
  { key: 'adminGroups', label: 'Admin groups (comma separated)', kind: 'text' },
  { key: 'editorGroups', label: 'Editor groups (comma separated)', kind: 'text' },
  role,
  { key: 'autoCreate', label: 'Create users on first login', kind: 'bool', default: false, help: 'Off by default: anyone who can sign in at the identity provider would otherwise get an account. Turn on only for a restricted provider (own tenant, allowed domains).' },
  { key: 'wantAssertionsSigned', label: 'Require signed assertions', kind: 'bool', default: true },
  { key: 'wantAuthnResponseSigned', label: 'Require signed response', kind: 'bool', default: false },
];
export const providerRunner = (kind: 'oidc' | 'ldap' | 'saml'): Runner => ({ type: kind, label: kind, category: 'auth', fields: kind === 'oidc' ? OIDC_FIELDS : kind === 'ldap' ? LDAP_FIELDS : SAML_FIELDS, run: async () => ({ ok: true }) });

type Role = 'admin' | 'editor' | 'viewer';
const csv = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const lines = (v: unknown) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** The identity provider vouched for the user, but none of their groups may use this application. */
export class GroupDenied extends Error { constructor() { super('User is not a member of an allowed group'); } }
/** Returned by ldapLogin when the directory accepted the password but the user is in no allowed group. */
export const NO_GROUP = 'no_group' as const;

/**
 * Group gate: with an allow-list set, the user needs one of those groups or one of the privileged (admin/editor) groups.
 * Someone who lost access also loses their open sessions right away instead of when the cookie expires.
 */
async function enforceGroups(ctx: Ctx, source: 'oidc' | 'ldap' | 'saml', externalId: string, allowed: string[], privileged: string[], groups: string[], fold = false): Promise<void> {
  if (!allowed.length) return;
  const norm = (g: string) => (fold ? g.toLowerCase() : g);
  const have = new Set(groups.map(norm));
  if ([...allowed, ...privileged].some((g) => have.has(norm(g)))) return;
  const u = await ctx.db.selectFrom('users').select('id').where('auth_source', '=', source).where('external_id', '=', externalId).executeTakeFirst();
  if (u) await ctx.db.deleteFrom('sessions').where('user_id', '=', u.id).execute();
  throw new GroupDenied();
}

/** Find or create the local record of an externally authenticated user. Returns null when the login must be refused. */
async function upsertExternal(ctx: Ctx, source: 'oidc' | 'ldap' | 'saml', externalId: string, p: { username: string; email?: string | null; displayName?: string; role?: Role; defaultRole: Role; create: boolean }): Promise<number | null> {
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

/** undefined = no LDAP provider enabled, null = rejected, NO_GROUP = valid login without an allowed group, number = local user id. */
export async function ldapLogin(ctx: Ctx, username: string, password: string): Promise<number | null | undefined | typeof NO_GROUP> {
  if (!password) return null; // an empty password would turn the bind into an anonymous (always successful) one
  const providers = await ctx.db.selectFrom('auth_providers').selectAll().where('kind', '=', 'ldap').where('enabled', '=', 1).execute();
  if (!providers.length) return undefined;
  let denied = false;
  for (const prov of providers) {
    const c = decryptJson<Record<string, any>>(prov.config_enc);
    const tls = { rejectUnauthorized: c.verifyTls !== false, ...trustOptions() };
    // ldapts switches a plain ldap:// connection to TLS as soon as any TLS option is set, so only ldaps:// gets them up front (STARTTLS passes them itself)
    const opts = { url: c.url, tlsOptions: /^ldaps:/i.test(String(c.url)) ? tls : undefined, connectTimeout: 5000, timeout: 10000 };
    const client = new Client(opts);
    try {
      if (c.startTls) await client.startTLS(tls);
      if (c.bindDn) await client.bind(c.bindDn, c.bindPassword ?? '');
      const filter = String(c.userFilter || '(uid={{username}})').replace(/\{\{\s*username\s*\}\}/g, escFilter(username));
      const { searchEntries } = await client.search(c.baseDn, { scope: 'sub', filter, attributes: ['dn', 'memberOf', c.emailAttr || 'mail', c.nameAttr || 'cn'], sizeLimit: 2 });
      if (searchEntries.length !== 1) continue; // unknown or ambiguous
      const entry = searchEntries[0];
      await client.unbind().catch(() => {});
      const userClient = new Client(opts);
      try { if (c.startTls) await userClient.startTLS(tls); await userClient.bind(entry.dn, password); } finally { await userClient.unbind().catch(() => {}); }
      const groups = ([] as string[]).concat((entry.memberOf as string | string[] | undefined) ?? []).map((g) => g.toLowerCase());
      const str = (v: unknown) => (Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v));
      await enforceGroups(ctx, 'ldap', entry.dn, lines(c.allowedGroupDns), [c.adminGroupDn, c.editorGroupDn].filter(Boolean).map(String), groups, true);
      const mapped: Role | undefined = c.adminGroupDn && groups.includes(String(c.adminGroupDn).toLowerCase()) ? 'admin' : c.editorGroupDn && groups.includes(String(c.editorGroupDn).toLowerCase()) ? 'editor' : c.adminGroupDn || c.editorGroupDn ? (c.defaultRole ?? 'viewer') : undefined;
      return await upsertExternal(ctx, 'ldap', entry.dn, { username, email: str(entry[c.emailAttr || 'mail']), displayName: str(entry[c.nameAttr || 'cn']), role: mapped, defaultRole: c.defaultRole ?? 'viewer', create: true });
    } catch (e) {
      if (e instanceof GroupDenied) denied = true; // another provider may still accept the user
      ctx.log.info({ err: (e as Error).message, provider: prov.id }, 'LDAP login failed');
    } finally { await client.unbind().catch(() => {}); }
  }
  return denied ? NO_GROUP : null;
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
  await enforceGroups(ctx, 'oidc', `${prov.id}:${claims.sub}`, csv(c.allowedGroups), [...admin, ...editor], groups);
  const mapped: Role | undefined = admin.some((g) => groups.includes(g)) ? 'admin' : editor.some((g) => groups.includes(g)) ? 'editor' : admin.length || editor.length ? (c.defaultRole ?? 'viewer') : undefined;
  if (info.email && info.email_verified === false) info.email = undefined; // never trust unverified addresses
  return upsertExternal(ctx, 'oidc', `${prov.id}:${claims.sub}`, {
    username: String(info.preferred_username ?? info.email ?? claims.sub).replace(/[^A-Za-z0-9._@-]/g, '_'), email: info.email as string | undefined, displayName: (info.name as string | undefined) ?? undefined,
    role: mapped, defaultRole: c.defaultRole ?? 'viewer', create: c.autoCreate === true,
  });
}

/* ----------------------------------- SAML ---------------------------------- */

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
/** One PEM block per certificate; a bare base64 body is accepted as a single certificate. */
export const samlCerts = (text: unknown): string[] => {
  const raw = String(text ?? '').trim();
  return raw.match(PEM) ?? (/^[A-Za-z0-9+/=\s]{100,}$/.test(raw) ? [raw.replace(/\s+/g, '')] : []);
};

/** Semantic checks the generic field validation cannot do. Returns error messages. */
export function samlConfigErrors(c: Record<string, any>): string[] {
  const errors: string[] = [];
  try {
    const u = new URL(String(c.entryPoint));
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) errors.push('IdP sign-on URL must use https');
  } catch { errors.push('IdP sign-on URL is not a valid URL'); }
  if (!samlCerts(c.idpCert).length) errors.push('IdP signing certificate must contain at least one PEM certificate');
  if (c.wantAssertionsSigned === false && c.wantAuthnResponseSigned !== true) errors.push('Require signed assertions or a signed response, unsigned logins are never accepted');
  return errors;
}

export const samlAcsUrl = (id: number) => `${config.baseUrl}/api/auth/saml/${id}/acs`;
export const samlEntityId = (id: number, c: Record<string, any>) => String(c.spEntityId || `${config.baseUrl}/api/auth/saml/${id}/metadata`);

/** Request ids live in the signed cookie, so node-saml gets a throwaway cache that is seeded per call (no shared memory across instances). */
function requestCache(seed?: string) {
  // node-saml reads the stored value as a creation timestamp (ISO string) to apply requestIdExpirationPeriodMs
  const ids = new Map<string, string>(seed ? [[seed, new Date().toISOString()]] : []);
  let created: string | undefined;
  const cache: CacheProvider = {
    saveAsync: async (key, value) => { created = key; ids.set(key, value); return { value, createdAt: Date.now() }; },
    getAsync: async (key) => ids.get(key) ?? null,
    removeAsync: async (key) => { if (key) ids.delete(key); return key; },
  };
  return { cache, created: () => created };
}

function samlFor(id: number, c: Record<string, any>, cache: CacheProvider): SAML {
  const entityId = samlEntityId(id, c);
  return new SAML({
    entryPoint: c.entryPoint, callbackUrl: samlAcsUrl(id), issuer: entityId, audience: entityId, idpCert: samlCerts(c.idpCert), idpIssuer: c.idpIssuer || undefined,
    wantAssertionsSigned: c.wantAssertionsSigned !== false, wantAuthnResponseSigned: c.wantAuthnResponseSigned === true,
    validateInResponseTo: ValidateInResponseTo.always, cacheProvider: cache, acceptedClockSkewMs: 120_000, maxAssertionAgeMs: 10 * 60_000,
    disableRequestedAuthnContext: true, // Entra ID rejects requests that demand a specific authn context
  });
}

const loadSaml = async (ctx: Ctx, id: number, enabledOnly: boolean) => {
  let q = ctx.db.selectFrom('auth_providers').selectAll().where('id', '=', id).where('kind', '=', 'saml');
  if (enabledOnly) q = q.where('enabled', '=', 1);
  const prov = await q.executeTakeFirst();
  return prov ? { prov, c: decryptJson<Record<string, any>>(prov.config_enc) } : null;
};

/** SP metadata XML for the IdP administrator. */
export async function samlMetadata(ctx: Ctx, id: number): Promise<string | null> {
  const p = await loadSaml(ctx, id, false);
  return p ? samlFor(id, p.c, requestCache().cache).generateServiceProviderMetadata(null, null) : null;
}

/** Builds the redirect to the IdP. `rs` (RelayState) and `id` (AuthnRequest id) go into the signed cookie. */
export async function samlStart(ctx: Ctx, id: number): Promise<{ url: string; state: { p: number; id: string; rs: string } } | null> {
  const p = await loadSaml(ctx, id, true);
  if (!p) return null;
  const rc = requestCache();
  const rs = crypto.randomBytes(16).toString('base64url');
  const url = await samlFor(id, p.c, rc.cache).getAuthorizeUrlAsync(rs, undefined, {});
  const reqId = rc.created();
  if (!reqId) throw new Error('SAML request id was not generated');
  return { url, state: { p: id, id: reqId, rs } };
}

/** Validates the posted response and returns the local user id, or null when the login is refused. Throws on invalid or replayed responses. */
export async function samlFinish(ctx: Ctx, body: Record<string, string>, st: { p: number; id: string; rs: string }): Promise<number | null> {
  const p = await loadSaml(ctx, st.p, true);
  if (!p || typeof body.SAMLResponse !== 'string' || !safeEqual(String(body.RelayState ?? ''), st.rs)) return null;
  const { c, prov } = p;
  const { profile } = await samlFor(prov.id, c, requestCache(st.id).cache).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
  if (!profile?.nameID) return null;
  // one-time use of the request id, shared across instances through the database
  await ctx.db.deleteFrom('settings').where('key', 'like', 'saml.used.%').where('updated_at', '<', new Date(Date.now() - 30 * 60_000)).execute();
  try { await ctx.db.insertInto('settings').values({ key: `saml.used.${st.id}`, value: '1' }).execute(); } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') throw new Error('SAML response was already used');
    throw e;
  }
  const attr = (name: string | undefined) => (name ? ([] as unknown[]).concat(profile[name] ?? []).map(String).filter(Boolean) : []);
  const email = attr(c.emailAttr)[0] ?? (profile.nameIDFormat?.endsWith('emailAddress') ? profile.nameID : undefined);
  const groups = attr(c.groupsAttr);
  const admin = csv(c.adminGroups), editor = csv(c.editorGroups);
  await enforceGroups(ctx, 'saml', `${prov.id}:${profile.nameID}`, csv(c.allowedGroups), [...admin, ...editor], groups);
  const mapped: Role | undefined = admin.some((g) => groups.includes(g)) ? 'admin' : editor.some((g) => groups.includes(g)) ? 'editor' : admin.length || editor.length ? (c.defaultRole ?? 'viewer') : undefined;
  return upsertExternal(ctx, 'saml', `${prov.id}:${profile.nameID}`, {
    username: String(email ?? profile.nameID).replace(/[^A-Za-z0-9._@-]/g, '_'), email, displayName: attr(c.nameAttr)[0],
    role: mapped, defaultRole: c.defaultRole ?? 'viewer', create: c.autoCreate === true,
  });
}
