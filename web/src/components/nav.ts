import { AlertTriangle, Bell, BookOpen, ChartNoAxesCombined, FolderTree, Globe, LayoutDashboard, MapPin, ScrollText, Settings, Users, Wrench, type LucideIcon } from 'lucide-react';

export type NavRole = 'editor' | 'admin';
export interface NavItem {
  to: string;
  /** i18n key of the label */
  label: string;
  icon: LucideIcon;
  role?: NavRole;
  end?: boolean;
  /** second key of the "g x" jump shortcut, if any */
  key?: string;
  /** which live counter the sidebar shows next to the entry */
  badge?: 'incidents';
}
export interface NavGroup { id: string; label: string; items: NavItem[] }

/** The single menu definition: the sidebar, the command palette and the shortcut help are all built from it. */
export const NAV_GROUPS: NavGroup[] = [
  { id: 'watch', label: 'nav.group.watch', items: [
    { to: '/dashboard', label: 'nav.dashboard', icon: LayoutDashboard, end: true, key: 'd' },
    { to: '/incidents', label: 'nav.incidents', icon: AlertTriangle, key: 'i', badge: 'incidents' },
    { to: '/insights', label: 'nav.insights', icon: ChartNoAxesCombined },
    { to: '/reports', label: 'nav.reports', icon: BookOpen, key: 'r' },
  ] },
  { id: 'configure', label: 'nav.group.configure', items: [
    { to: '/groups', label: 'nav.groups', icon: FolderTree, role: 'editor' },
    { to: '/maintenance', label: 'nav.maintenance', icon: Wrench, key: 'm' },
    { to: '/status-pages', label: 'nav.statusPages', icon: Globe, key: 's' },
    { to: '/notifications', label: 'nav.notifications', icon: Bell, role: 'editor', key: 'n' },
    { to: '/probes', label: 'nav.probes', icon: MapPin, role: 'editor' },
  ] },
  { id: 'system', label: 'nav.group.system', items: [
    { to: '/users', label: 'nav.users', icon: Users, role: 'admin' },
    { to: '/audit', label: 'nav.audit', icon: ScrollText, role: 'admin' },
    { to: '/settings', label: 'nav.settings', icon: Settings, role: 'admin' },
  ] },
];

/** Groups with the entries the current role may open; empty groups are dropped. */
export function visibleNav(can: (role: NavRole) => boolean): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.role || can(i.role)) })).filter((g) => g.items.length > 0);
}
