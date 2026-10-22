import { Users } from 'lucide-react';
import type { ServerInfo } from '../lib/api';
import { useT } from '../lib/i18n';
import { cx } from './ui';

/** "7 of 50 players online" with a small icon, or just "7/50" when space is tight. Renders nothing without a player count. */
export function PlayersLine({ info, short, className }: { info: ServerInfo; short?: boolean; className?: string }) {
  const t = useT();
  if (info.players === undefined) return null;
  const full = info.maxPlayers !== undefined ? t('info.players', { n: info.players, max: info.maxPlayers }) : t('info.playersNoMax', { n: info.players });
  return <span className={cx('inline-flex items-center gap-1', className)} title={short ? full : undefined} aria-label={full}><Users className="h-3.5 w-3.5 shrink-0" aria-hidden />{short ? (info.maxPlayers !== undefined ? `${info.players}/${info.maxPlayers}` : info.players) : full}</span>;
}

/** Everything a game server reports: players, version, message of the day and who is online. */
export function ServerInfoBlock({ info, className }: { info: ServerInfo; className?: string }) {
  const t = useT();
  const bits = [info.version && t('info.version', { v: info.version }), info.map && t('info.map', { v: info.map }), info.state && t('info.state', { v: info.state })].filter(Boolean) as string[];
  return (
    <div className={cx('space-y-1 text-xs text-slate-600 dark:text-slate-400', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5"><PlayersLine info={info} />{bits.map((b) => <span key={b}>{b}</span>)}</div>
      {info.motd && <p className="italic">{info.motd}</p>}
      {info.names && info.names.length > 0 && <p><span className="font-medium">{t('info.onlineNow')}:</span> {info.names.join(', ')}</p>}
    </div>
  );
}
