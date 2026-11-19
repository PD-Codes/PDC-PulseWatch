import { beforeEach, describe, expect, it } from 'vitest';

// minimal browser stubs: theme.ts paints the document and reads localStorage
const mem = new Map<string, string>();
const g = globalThis as any;
g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
g.document = { documentElement: { dataset: {} as Record<string, string>, classList: { toggle() {} }, style: {} }, querySelector: () => null };
g.window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false, addEventListener() {} }) });
g.CustomEvent = class extends Event { detail: unknown; constructor(t: string, i?: { detail?: unknown }) { super(t); this.detail = i?.detail; } };

const { applyProfileTheme, applyProfileMode, rememberProfileTheme, clearDeviceTheme, forgetServerAppearance } = await import('../../web/src/lib/auth');

const id = () => mem.get('pw.theme.id');

describe('profile theme on a shared device', () => {
  beforeEach(() => mem.clear());

  it('applies the profile theme on a device without a choice of its own', () => {
    applyProfileTheme('nord');
    expect(id()).toBe('nord');
    expect(mem.get('pw.theme.fromServer')).toBe('nord');
  });

  it('keeps a theme picked on the device', () => {
    mem.set('pw.theme.id', 'terminal');
    applyProfileTheme('nord');
    expect(id()).toBe('terminal');
  });

  it('follows a profile change made elsewhere while the device only holds the earlier profile value', () => {
    applyProfileTheme('nord');
    applyProfileTheme('smooth');
    expect(id()).toBe('smooth');
  });

  it('a person without a theme gets the instance default instead of the previous person\'s theme', () => {
    applyProfileTheme('nord');
    applyProfileTheme(null);
    expect(id()).toBeUndefined();
    expect(mem.has('pw.theme.fromServer')).toBe(false);
  });

  it('a person without a theme keeps a theme chosen on the device', () => {
    mem.set('pw.theme.id', 'terminal');
    applyProfileTheme(null);
    expect(id()).toBe('terminal');
  });

  it('sign-out drops a theme and mode that came from the profile, and keeps device choices', () => {
    applyProfileTheme('nord'); applyProfileMode('dark');
    forgetServerAppearance();
    expect(id()).toBeUndefined();
    expect(mem.has('pw.theme')).toBe(false);
    mem.set('pw.theme.id', 'terminal'); mem.set('pw.theme', 'light');
    forgetServerAppearance();
    expect(id()).toBe('terminal');
    expect(mem.get('pw.theme')).toBe('light');
    expect(mem.has('pw.theme.fromServer')).toBe(false);
  });

  it('a save from this device counts as the server value, and "instance default" clears the choice', () => {
    mem.set('pw.theme.id', 'nord');
    rememberProfileTheme('nord', 'dark');
    applyProfileTheme('nord');
    expect(id()).toBe('nord');
    clearDeviceTheme();
    expect(id()).toBeUndefined();
  });
});
