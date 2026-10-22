import { describe, expect, it } from 'vitest';
import { tlsMessage, type TlsFacts } from '../../src/core';

const facts = (days: number): TlsFacts => ({
  host: 'example.test', port: 443, subject: 'example.test', issuer: 'Test CA', daysLeft: days,
  validFrom: new Date(Date.now() - 30 * 86_400_000).toISOString(), validTo: new Date(Date.now() + days * 86_400_000).toISOString(), altNames: [], fingerprint256: '', selfSigned: false,
});

describe('certificate notices in two languages', () => {
  it('keeps the English text and adds a German one', () => {
    expect(tlsMessage(facts(5), { expiring: true })).toMatch(/^TLS certificate expires on \d{4}-\d{2}-\d{2} \(in 5 days\): CN=example.test, issuer CN=Test CA, host example.test:443$/);
    expect(tlsMessage(facts(5), { expiring: true, lang: 'de' })).toMatch(/^TLS-Zertifikat läuft am \d{4}-\d{2}-\d{2} ab \(in 5 Tagen\): CN=example.test, Aussteller CN=Test CA, Host example.test:443$/);
    expect(tlsMessage(facts(1), { expiring: true, lang: 'de' })).toContain('in 1 Tag)');
    expect(tlsMessage(facts(-3), { expiring: true, lang: 'de' })).toMatch(/ist am \d{4}-\d{2}-\d{2} abgelaufen \(vor 3 Tagen\)/);
  });
});
