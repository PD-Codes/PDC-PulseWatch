import { describe, expect, it } from 'vitest';
import { slugify } from '../../web/src/lib/format';

describe('slugify', () => {
  it('turns a title into a URL slug', () => {
    expect(slugify('Public Services')).toBe('public-services');
    expect(slugify('  Intern / Admin -- Tools!  ')).toBe('intern-admin-tools');
  });
  it('writes German umlauts and accents the readable way', () => {
    expect(slugify('Größe & Übersicht')).toBe('groesse-uebersicht');
    expect(slugify('Café Müller')).toBe('cafe-mueller');
  });
  it('gives something the server accepts, or an empty string while there is nothing usable yet', () => {
    expect(slugify('')).toBe('');
    expect(slugify('***')).toBe('');
    const long = slugify('a'.repeat(100) + ' b');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slugify('x'.repeat(62) + ' y')).toBe('x'.repeat(62)); // cut inside the dash must not leave a trailing dash
  });
});
