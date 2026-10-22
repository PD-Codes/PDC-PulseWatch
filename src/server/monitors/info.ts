/** Game server details shown next to a monitor (players online, version, ...), normalized from what the different game runners report. */
export interface ServerInfo { players?: number; maxPlayers?: number; names?: string[]; version?: string; motd?: string; map?: string; name?: string; state?: string }

/** Monitor types whose checks report server details; other runners use the same detail keys for other things. */
export const GAME_TYPES = new Set(['minecraft', 'steam', 'gamedig', 'pelican', 'amp']);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Whitelist and bound everything: the result is stored and shown on public pages. */
export function pickInfo(type: string, d: Record<string, unknown> | undefined): ServerInfo | null {
  if (!d || !GAME_TYPES.has(type)) return null;
  const names = Array.isArray(d.names) ? d.names.filter((n): n is string => typeof n === 'string' && !!n.trim()).slice(0, 30).map((n) => n.replace(/[\x00-\x1f§]/g, '').trim().slice(0, 40)).filter(Boolean) : [];
  const out: ServerInfo = {
    players: num(d.players ?? d.online), maxPlayers: num(d.maxPlayers ?? d.max), names: names.length ? names : undefined,
    version: str(d.version, 60), motd: str(d.motd, 200), map: str(d.map, 60), name: str(d.name, 80), state: str(d.state, 30),
  };
  const clean = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as ServerInfo;
  return Object.keys(clean).length ? clean : null;
}

/** What a visitor of a status page may see: 0 nothing, 1 counts and version, 2 also who is online. */
export function publicInfo(info: ServerInfo | null, level: number): ServerInfo | null {
  if (!info || level < 1) return null;
  if (level >= 2) return info;
  const { names: _names, ...rest } = info;
  return rest;
}
