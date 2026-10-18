import type { Ctx } from '../context';
import type { AuthUser } from './plugin';

/**
 * Restricted users only see what they were granted: monitor groups (including descendants) and status pages.
 * Unrestricted users are limited by their role only.
 */
export async function accessibleGroupIds(ctx: Ctx, user: AuthUser, level: 'view' | 'manage' = 'view'): Promise<Set<number> | null> {
  if (!user.scopeRestricted || user.role === 'admin') return null;
  const grants = await ctx.db.selectFrom('permission_grants').select(['resource_id', 'level']).where('user_id', '=', user.id).where('resource_type', '=', 'monitor_group').execute();
  const roots = grants.filter((g) => level === 'view' || g.level === 'manage').map((g) => g.resource_id);
  const all = new Set(roots);
  if (!all.size) return all;
  const groups = await ctx.db.selectFrom('monitor_groups').select(['id', 'parent_id']).execute();
  let grew = true;
  while (grew) { grew = false; for (const g of groups) if (g.parent_id && all.has(g.parent_id) && !all.has(g.id)) { all.add(g.id); grew = true; } }
  return all;
}

/** Monitor ids the user may see/manage, or null when unrestricted. */
export async function accessibleMonitorIds(ctx: Ctx, user: AuthUser, level: 'view' | 'manage' = 'view'): Promise<number[] | null> {
  const groups = await accessibleGroupIds(ctx, user, level);
  if (groups === null) return null;
  if (!groups.size) return [];
  return (await ctx.db.selectFrom('monitors').select('id').where('group_id', 'in', [...groups]).execute()).map((m) => m.id);
}

export const canWrite = (u: AuthUser) => u.role === 'admin' || u.role === 'editor';

export async function canManageMonitor(ctx: Ctx, user: AuthUser, monitorId: number, level: 'view' | 'manage' = 'manage'): Promise<boolean> {
  if (level === 'manage' && !canWrite(user)) return false;
  const ids = await accessibleMonitorIds(ctx, user, level);
  return ids === null || ids.includes(monitorId);
}

export async function writeAudit(ctx: Ctx, user: Pick<AuthUser, 'id' | 'username'> | null, action: string, entity: { type?: string; id?: string | number } = {}, details?: unknown, ip?: string): Promise<void> {
  await ctx.db.insertInto('audit_log').values({
    user_id: user?.id ?? null, actor: user?.username ?? 'system', action, entity_type: entity.type ?? null, entity_id: entity.id !== undefined ? String(entity.id) : null,
    ip: ip ?? null, details: details === undefined ? null : JSON.stringify(details).slice(0, 8000),
  }).execute().catch((e) => ctx.log.warn({ err: e }, 'audit write failed'));
}
