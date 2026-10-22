import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './harness';

// The fixture key pair plays the identity provider's signing key.
const KEY = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/localhost.key'), 'utf8');
const CRT = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/localhost.crt'), 'utf8');
const IDP = 'https://sts.example.com/idp';

let t: TestApp;
let pid: number;
let acs: string;
let entityId: string;
beforeAll(async () => {
  t = await startApp();
  const admin = t.client();
  await admin.post('/api/setup', { username: 'admin', password: 'correct-horse-battery-1' });
  const r = await admin.post('/api/auth/providers', {
    kind: 'saml', name: 'Entra', enabled: true,
    config: { entryPoint: 'https://login.example.com/saml2', idpIssuer: IDP, idpCert: CRT, emailAttr: 'email', nameAttr: 'name', groupsAttr: 'groups', adminGroups: 'g-admin', editorGroups: 'g-edit', defaultRole: 'viewer', autoCreate: true },
  });
  expect(r.status).toBe(200);
  pid = r.json.id;
  const list = (await admin.get('/api/auth/providers')).json.items.find((p: any) => p.id === pid);
  acs = list.urls.acs; entityId = list.urls.entityId;
});
afterAll(async () => { await t?.close(); });

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

function signedResponse(o: { inResponseTo: string; audience?: string; name?: string; email?: string; groups?: string[]; tamper?: boolean }): string {
  const attr = (n: string, vs: string[]) => `<saml:Attribute Name="${n}">${vs.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join('')}</saml:Attribute>`;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${Math.random().toString(16).slice(2)}" Version="2.0" IssueInstant="${iso()}">
<saml:Issuer>${IDP}</saml:Issuer>
<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${o.name ?? 'user-1'}</saml:NameID>
<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(300_000)}" Recipient="${acs}" InResponseTo="${o.inResponseTo}"/></saml:SubjectConfirmation></saml:Subject>
<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
<saml:AuthnStatement AuthnInstant="${iso()}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
<saml:AttributeStatement>${attr('email', [o.email ?? 'user1@example.com'])}${attr('name', ['User One'])}${attr('groups', o.groups ?? [])}</saml:AttributeStatement>
</saml:Assertion>`;
  const sig = new SignedXml({ privateKey: KEY, publicCert: CRT, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  let signed = sig.getSignedXml();
  if (o.tamper) signed = signed.replace(o.email ?? 'user1@example.com', 'attacker@example.com'); // changes signed content after signing
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(16).slice(2)}" Version="2.0" IssueInstant="${iso()}" Destination="${acs}" InResponseTo="${o.inResponseTo}"><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}

/** Starts a login like the browser would and returns what the IdP would see plus the cookie to send back. */
async function start() {
  const c = t.client();
  const r = await c.get(`/api/auth/saml/${pid}/start`);
  expect(r.status).toBe(302);
  const url = new URL(r.headers.location as string);
  const request = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
  return { c, requestId: /ID="([^"]+)"/.exec(request)![1], relay: url.searchParams.get('RelayState')!, cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
}
const post = (c: ReturnType<TestApp['client']>, body: Record<string, string>, cookie?: string) =>
  c.call('POST', `/api/auth/saml/${pid}/acs`, new URLSearchParams(body).toString(), { headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) } });

describe('SAML sign-in', () => {
  it('serves SP metadata with the reply URL and entity ID', async () => {
    const r = await t.client().get(`/api/auth/saml/${pid}/metadata`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(acs);
    expect(r.body).toContain(entityId);
  });

  it('logs in a valid signed response and maps groups to a role', async () => {
    const s = await start();
    const r = await post(s.c, { SAMLResponse: signedResponse({ inResponseTo: s.requestId, groups: ['g-admin'] }), RelayState: s.relay });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/dashboard');
    const me = await s.c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect([me.json.role, me.json.authSource, me.json.email]).toEqual(['admin', 'saml', 'user1@example.com']);
  });

  it('rejects a tampered assertion', async () => {
    const s = await start();
    const r = await post(s.c, { SAMLResponse: signedResponse({ inResponseTo: s.requestId, name: 'user-2', tamper: true }), RelayState: s.relay });
    expect(r.headers.location).toContain('/login?error=sso_failed');
    expect((await s.c.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a wrong audience', async () => {
    const s = await start();
    const r = await post(s.c, { SAMLResponse: signedResponse({ inResponseTo: s.requestId, name: 'user-3', audience: 'https://other.example.com' }), RelayState: s.relay });
    expect(r.headers.location).toContain('sso_failed');
  });

  it('rejects a replayed response, an unsolicited response and a wrong relay state', async () => {
    const s = await start();
    const body = { SAMLResponse: signedResponse({ inResponseTo: s.requestId, name: 'user-4', email: 'u4@example.com' }), RelayState: s.relay };
    expect((await post(s.c, body, s.cookie)).headers.location).toBe('/dashboard'); // first use succeeds
    const replay = await post(t.client(), body, s.cookie); // attacker re-sends the captured response with the captured cookie
    expect(replay.headers.location).toContain('sso_failed');
    const unsolicited = await post(t.client(), { SAMLResponse: signedResponse({ inResponseTo: '_forged' }), RelayState: 'x' });
    expect(unsolicited.headers.location).toContain('state_expired');
    const s2 = await start();
    const wrongRelay = await post(s2.c, { SAMLResponse: signedResponse({ inResponseTo: s2.requestId, name: 'user-5' }), RelayState: 'not-the-state' });
    expect(wrongRelay.headers.location).toContain('not_allowed');
  });

  it('validates the provider configuration', async () => {
    const admin = t.client();
    await admin.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
    const bad = await admin.post('/api/auth/providers', { kind: 'saml', name: 'Bad', enabled: true, config: { entryPoint: 'http://idp.example.com/sso', idpCert: 'not a cert' } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('https');
    expect(bad.json.message).toContain('certificate');
  });
});

describe('SAML group allow-list', () => {
  const config = (allowedGroups: string) => ({ entryPoint: 'https://login.example.com/saml2', idpIssuer: IDP, idpCert: CRT, emailAttr: 'email', nameAttr: 'name', groupsAttr: 'groups', adminGroups: 'g-admin', editorGroups: 'g-edit', defaultRole: 'viewer', autoCreate: true, allowedGroups });
  const login = async (name: string, groups: string[]) => {
    const s = await start();
    const r = await post(s.c, { SAMLResponse: signedResponse({ inResponseTo: s.requestId, name, email: `${name}@example.com`, groups }), RelayState: s.relay });
    return { s, r };
  };
  let admin: ReturnType<TestApp['client']>;
  beforeAll(async () => {
    admin = t.client();
    await admin.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
    expect((await admin.put(`/api/auth/providers/${pid}`, { kind: 'saml', name: 'Entra', enabled: true, config: config('g-staff') })).status).toBe(200);
  });

  it('lets members of an allowed group in, and admin or editor groups count as allowed', async () => {
    for (const [name, groups] of [['gate-1', ['g-staff']], ['gate-2', ['g-admin']], ['gate-3', ['g-edit']]] as const) {
      const { s, r } = await login(name, [...groups]);
      expect(r.headers.location, name).toBe('/dashboard');
      expect((await s.c.get('/api/auth/me')).status).toBe(200);
    }
  });

  it('shows a notice when nobody is allowed in and no status page is public', async () => {
    const { s, r } = await login('gate-4', ['g-other']);
    expect(r.headers.location).toContain('/login?error=no_access');
    expect((await s.c.get('/api/auth/me')).status).toBe(401);
    const users = (await admin.get('/api/users')).json as { username: string }[];
    expect(users.some((u) => u.username.startsWith('gate-1'))).toBe(true); // the list is the array we think it is
    expect(users.some((u) => u.username.startsWith('gate-4'))).toBe(false); // and the refused user got no account
  });

  it('sends everyone else to the open status page, and ends the sessions of someone who lost access', async () => {
    const page = await admin.post('/api/status-pages', { slug: 'public-one', title: 'Public', isPublic: true, sections: [] });
    expect(page.status).toBe(200);
    const first = await login('gate-5', ['g-staff']);
    expect(first.r.headers.location).toBe('/dashboard');
    const again = await login('gate-5', []); // same user, removed from the group
    expect(again.r.headers.location).toBe('/status/public-one');
    expect((await first.s.c.get('/api/auth/me')).status).toBe(401);
  });

  it('does not restrict anyone when the list is empty', async () => {
    await admin.put(`/api/auth/providers/${pid}`, { kind: 'saml', name: 'Entra', enabled: true, config: config('') });
    const { r } = await login('gate-6', []);
    expect(r.headers.location).toBe('/dashboard');
  });
});

describe('SAML editors and admins only', () => {
  const config = (extra: object) => ({ entryPoint: 'https://login.example.com/saml2', idpIssuer: IDP, idpCert: CRT, emailAttr: 'email', nameAttr: 'name', groupsAttr: 'groups', adminGroups: 'g-admin', editorGroups: 'g-edit', defaultRole: 'viewer', autoCreate: true, ...extra });
  const login = async (name: string, groups: string[]) => {
    const s = await start();
    return post(s.c, { SAMLResponse: signedResponse({ inResponseTo: s.requestId, name, email: `${name}@example.com`, groups }), RelayState: s.relay });
  };
  let admin: ReturnType<TestApp['client']>;
  beforeAll(async () => {
    admin = t.client();
    await admin.post('/api/auth/login', { username: 'admin', password: 'correct-horse-battery-1' });
  });
  const put = (extra: object) => admin.put(`/api/auth/providers/${pid}`, { kind: 'saml', name: 'Entra', enabled: true, config: config(extra) });

  it('lets only members of the admin or editor groups in, even when an allowed group is listed', async () => {
    expect((await put({ staffOnly: true, allowedGroups: 'g-staff' })).status).toBe(200);
    expect((await login('staff-1', ['g-edit'])).headers.location).toBe('/dashboard');
    expect((await login('staff-2', ['g-admin'])).headers.location).toBe('/dashboard');
    // the status page created in the previous block is public, so refused users are sent there
    expect((await login('staff-3', ['g-staff'])).headers.location).toBe('/status/public-one'); // would only be a viewer
    expect((await login('staff-4', [])).headers.location).toBe('/status/public-one');
  });

  it('has no effect when everybody becomes an editor anyway', async () => {
    expect((await put({ staffOnly: true, defaultRole: 'editor' })).status).toBe(200);
    expect((await login('staff-5', [])).headers.location).toBe('/dashboard');
  });
});
