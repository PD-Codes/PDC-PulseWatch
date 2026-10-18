import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Pencil, Plus, ShieldCheck, Trash2, Users as UsersIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Toggle, useConfirm, useToast } from '../components/ui';
import { del, errorMessage, get, patch, post, put, type Group, type Role } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, relTime } from '../lib/format';
import { useT } from '../lib/i18n';

interface User { id: number; username: string; displayName: string; email: string | null; role: Role; scopeRestricted: boolean; authSource: 'local' | 'oidc' | 'ldap'; isActive: boolean; totpEnabled: boolean; createdAt: string; lastLoginAt: string | null; locked: boolean }
interface PageRef { id: number; title: string }
type Level = 'view' | 'manage';
const ROLES: Role[] = ['admin', 'editor', 'viewer'];

export default function Users() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<User | null>(null);
  const [grants, setGrants] = useState<User | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<User[]>('/api/users') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  return (
    <>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} actions={<Button variant="primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" />{t('users.new')}</Button>} />
      <Card>
        {users.isLoading ? <Loading /> : users.error ? <div className="p-4"><ErrorBox error={users.error} /></div> : !users.data?.length ? <EmptyState icon={<UsersIcon className="h-6 w-6" />} title={t('users.empty')} /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t('users.user')}</th><th>{t('users.role')}</th><th>{t('users.source')}</th><th>{t('common.status')}</th><th>{t('users.lastLogin')}</th><th className="text-right">{t('common.actions')}</th></tr></thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td><div className="font-medium">{u.displayName}</div><div className="text-xs text-slate-500">{u.username}{u.email ? ` · ${u.email}` : ''}</div></td>
                    <td><Badge tone={u.role === 'admin' ? 'brand' : u.role === 'editor' ? 'blue' : 'gray'}>{t(`users.role.${u.role}`)}</Badge>{u.scopeRestricted && <Badge tone="amber" className="ml-1"><Lock className="h-3 w-3" />{t('users.restricted')}</Badge>}</td>
                    <td><Badge>{u.authSource}</Badge>{u.totpEnabled && <Badge tone="green" className="ml-1"><ShieldCheck className="h-3 w-3" />2FA</Badge>}</td>
                    <td>{!u.isActive ? <Badge tone="red">{t('users.inactive')}</Badge> : u.locked ? <Badge tone="amber">{t('users.locked')}</Badge> : <Badge tone="green">{t('common.active')}</Badge>}</td>
                    <td className="whitespace-nowrap text-slate-500" title={fmtDateTime(u.lastLoginAt)}>{u.lastLoginAt ? relTime(u.lastLoginAt) : t('common.never')}</td>
                    <td className="whitespace-nowrap text-right">
                      {u.scopeRestricted && <Button size="sm" variant="ghost" onClick={() => setGrants(u)}><KeyRound className="h-4 w-4" />{t('users.permissions')}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setEdit(u)} aria-label={`${t('common.edit')} ${u.username}`}><Pencil className="h-4 w-4" />{t('common.edit')}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <CreateUser open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); void refresh(); toast(t('common.saved')); }} />
      {edit && <EditUser user={edit} selfId={me?.id} onClose={() => setEdit(null)} onChanged={() => void refresh()} onGrants={(u) => { setEdit(null); setGrants(u); }} />}
      {grants && <Grants user={grants} onClose={() => setGrants(null)} />}
    </>
  );
}

function CreateUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const empty = { username: '', displayName: '', email: '', password: '', role: 'viewer' as Role, scopeRestricted: false };
  const [f, setF] = useState(empty);
  useEffect(() => { if (open) { setF(empty); m.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({ mutationFn: () => post('/api/users', { ...f, displayName: f.displayName || undefined, email: f.email || undefined }), onSuccess: onDone });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title={t('users.new')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="create-user" loading={m.isPending}>{t('common.create')}</Button></>}>
      <form id="create-user" onSubmit={submit} className="space-y-3">
        {m.error ? <ErrorBox error={m.error} /> : null}
        <Field label={t('auth.username')}>{(id) => <Input id={id} value={f.username} onChange={set('username')} required minLength={3} pattern="[A-Za-z0-9._@\-]+" autoComplete="off" />}</Field>
        <Field label={t('auth.displayName')}>{(id) => <Input id={id} value={f.displayName} onChange={set('displayName')} />}</Field>
        <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} />}</Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}>{(id) => <Input id={id} type="password" value={f.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />}</Field>
        <Field label={t('users.role')}>{(id) => <Select id={id} value={f.role} onChange={set('role')}>{ROLES.map((r) => <option key={r} value={r}>{t(`users.role.${r}`)}</option>)}</Select>}</Field>
        <div><Toggle checked={f.scopeRestricted} onChange={(v) => setF({ ...f, scopeRestricted: v })} label={t('users.restrictedLabel')} /><p className="hint">{t('users.restrictedHint')}</p></div>
      </form>
    </Modal>
  );
}

function EditUser({ user, selfId, onClose, onChanged, onGrants }: { user: User; selfId?: number; onClose: () => void; onChanged: () => void; onGrants: (u: User) => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setF] = useState({ displayName: user.displayName, email: user.email ?? '', role: user.role, scopeRestricted: user.scopeRestricted, isActive: user.isActive });
  const [pw, setPw] = useState('');
  const isSelf = selfId === user.id;
  const run = useMutation({ mutationFn: (body: Record<string, unknown>) => patch(`/api/users/${user.id}`, body), onSuccess: () => onChanged() });
  const save = useMutation({
    mutationFn: () => patch(`/api/users/${user.id}`, { displayName: f.displayName, email: f.email || null, role: f.role, scopeRestricted: f.scopeRestricted, isActive: f.isActive }),
    onSuccess: () => { onChanged(); toast(t('common.saved')); if (f.scopeRestricted) onGrants({ ...user, ...f, email: f.email || null }); else onClose(); },
  });
  const act = async (body: Record<string, unknown>, ok: string) => { try { await run.mutateAsync(body); toast(ok); } catch (e) { toast(errorMessage(e), 'error'); } };
  const remove = async () => {
    if (!(await confirm({ title: t('common.delete'), body: t('common.deleteConfirm', { name: user.username }), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await del(`/api/users/${user.id}`); onChanged(); toast(t('common.deleted')); onClose(); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <Modal open onClose={onClose} title={`${t('common.edit')}: ${user.username}`} wide footer={<><Button onClick={onClose}>{t('common.close')}</Button><Button variant="primary" type="submit" form="edit-user" loading={save.isPending}>{t('common.save')}</Button></>}>
      <form id="edit-user" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-3 sm:grid-cols-2">
        {save.error ? <div className="sm:col-span-2"><ErrorBox error={save.error} /></div> : null}
        <Field label={t('auth.displayName')}>{(id) => <Input id={id} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required />}</Field>
        <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label={t('users.role')}>{(id) => <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{t(`users.role.${r}`)}</option>)}</Select>}</Field>
        <div className="space-y-2 pt-6">
          <Toggle checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label={t('common.active')} disabled={isSelf} />
          <div><Toggle checked={f.scopeRestricted} onChange={(v) => setF({ ...f, scopeRestricted: v })} label={t('users.restrictedLabel')} /></div>
        </div>
      </form>
      {user.scopeRestricted && <div className="mt-3"><Button size="sm" onClick={() => onGrants(user)}><KeyRound className="h-4 w-4" />{t('users.permissions')}</Button></div>}

      <div className="mt-6 space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-semibold">{t('users.security')}</h3>
        {user.authSource === 'local' ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act({ password: pw }, t('users.passwordChanged')).then(() => setPw('')); }}>
            <Field label={t('users.newPassword')} className="min-w-[14rem] flex-1">{(id) => <Input id={id} type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={10} autoComplete="new-password" />}</Field>
            <Button type="submit" disabled={pw.length < 10} loading={run.isPending}>{t('users.resetPassword')}</Button>
          </form>
        ) : <p className="text-sm text-slate-500">{t('users.externalPassword', { source: user.authSource })}</p>}
        <div className="flex flex-wrap gap-2">
          {user.totpEnabled && <Button onClick={async () => { if (await confirm({ title: t('users.reset2fa'), body: t('users.reset2faConfirm'), confirmLabel: t('users.reset2fa') })) void act({ resetTotp: true }, t('users.reset2faDone')); }}>{t('users.reset2fa')}</Button>}
          {user.locked && <Button onClick={() => void act({ unlock: true }, t('users.unlocked'))}>{t('users.unlock')}</Button>}
          <Button variant="danger" onClick={remove} disabled={isSelf}><Trash2 className="h-4 w-4" />{t('common.delete')}</Button>
        </div>
        {isSelf && <p className="hint">{t('users.selfHint')}</p>}
      </div>
    </Modal>
  );
}

function Grants({ user, onClose }: { user: User; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => get<Group[]>('/api/groups') });
  const pages = useQuery({ queryKey: ['status-pages'], queryFn: () => get<PageRef[]>('/api/status-pages') });
  const current = useQuery({ queryKey: ['grants', user.id], queryFn: () => get<{ type: string; id: number; level: Level }[]>(`/api/users/${user.id}/grants`), gcTime: 0 });
  const [sel, setSel] = useState<Record<string, Level> | null>(null);
  useEffect(() => { if (current.data && !sel) setSel(Object.fromEntries(current.data.map((g) => [`${g.type}:${g.id}`, g.level]))); }, [current.data, sel]);

  const save = useMutation({
    mutationFn: () => put(`/api/users/${user.id}/grants`, { grants: Object.entries(sel ?? {}).map(([k, level]) => { const [type, id] = k.split(':'); return { type, id: Number(id), level }; }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['grants', user.id] }); toast(t('common.saved')); onClose(); },
  });
  const path = (g: Group): string => { const p = groups.data?.find((x) => x.id === g.parentId); return p ? `${path(p)} / ${g.name}` : g.name; };
  const row = (key: string, label: string) => {
    const level = sel?.[key];
    return (
      <div key={key} className="flex items-center justify-between gap-3 py-1.5">
        <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={!!level} onChange={(e) => setSel((s) => { const n = { ...(s ?? {}) }; if (e.target.checked) n[key] = 'view'; else delete n[key]; return n; })} /><span className="truncate">{label}</span></label>
        <Select className="!w-32 shrink-0" disabled={!level} value={level ?? 'view'} aria-label={`${label}: ${t('users.level')}`} onChange={(e) => setSel((s) => ({ ...(s ?? {}), [key]: e.target.value as Level }))}><option value="view">{t('users.level.view')}</option><option value="manage">{t('users.level.manage')}</option></Select>
      </div>
    );
  };
  const loading = groups.isLoading || pages.isLoading || current.isLoading || !sel;
  return (
    <Modal open onClose={onClose} title={`${t('users.permissions')}: ${user.username}`} wide footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={loading}>{t('common.save')}</Button></>}>
      {loading ? <Loading /> : (
        <div className="space-y-5">
          {save.error ? <ErrorBox error={save.error} /> : null}
          <p className="text-sm text-slate-500">{t('users.grantsHint')}</p>
          <section><h3 className="mb-1 text-sm font-semibold">{t('users.groups')}</h3>{groups.data?.length ? <div className="divide-y divide-slate-100 dark:divide-slate-800">{groups.data.map((g) => row(`monitor_group:${g.id}`, path(g)))}</div> : <p className="text-sm text-slate-500">{t('users.noGroups')}</p>}</section>
          <section><h3 className="mb-1 text-sm font-semibold">{t('users.statusPages')}</h3>{pages.data?.length ? <div className="divide-y divide-slate-100 dark:divide-slate-800">{pages.data.map((p) => row(`status_page:${p.id}`, p.title))}</div> : <p className="text-sm text-slate-500">{t('users.noPages')}</p>}</section>
        </div>
      )}
    </Modal>
  );
}
