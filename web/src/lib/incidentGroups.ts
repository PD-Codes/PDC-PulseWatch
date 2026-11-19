// Folds repeated incidents of the same monitor(s) and title into one row (flapping creates one incident per drop). Pure, no DOM.

export interface GroupableIncident { id: number; title: string; startedAt: string; monitors: { id: number }[] }
export interface IncidentGroup<T> { key: string; /** newest first, as in the input */ items: T[]; head: T }

/** Same monitors and same title: the identity of "the same outage" over and over. */
export const incidentKey = (i: GroupableIncident): string => `${i.monitors.map((m) => m.id).sort((a, b) => a - b).join(',')}|${i.title.trim().toLowerCase()}`;

/**
 * Groups incidents that share monitors and title and start at most `windowMs` apart (each one measured against its predecessor, so a long flapping run stays one group).
 * Order follows the first (newest) member of each group; a list that is newest first stays that way.
 */
export function groupIncidents<T extends GroupableIncident>(list: T[], windowMs = 3_600_000): IncidentGroup<T>[] {
  const out: IncidentGroup<T>[] = [];
  const open = new Map<string, IncidentGroup<T>>();
  for (const i of list) {
    const key = incidentKey(i);
    const g = open.get(key);
    const last = g?.items[g.items.length - 1];
    if (g && last && Math.abs(Date.parse(last.startedAt) - Date.parse(i.startedAt)) <= windowMs) { g.items.push(i); continue; }
    const fresh: IncidentGroup<T> = { key, items: [i], head: i };
    open.set(key, fresh);
    out.push(fresh);
  }
  return out;
}
