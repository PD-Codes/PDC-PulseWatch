import { Badge } from './ui';
import { useT } from '../lib/i18n';

export interface Counts { created: number; updated: number }
export interface Report { dryRun: boolean; counts: Record<string, Counts>; warnings: string[]; errors: string[] }
const SECTIONS = ['groups', 'tags', 'templates', 'channels', 'policies', 'monitors', 'maintenance', 'statusPages'];

export function ReportView({ report }: { report: Report }) {
  const t = useT();
  const rows = SECTIONS.filter((s) => report.counts[s] && (report.counts[s].created || report.counts[s].updated));
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex items-center gap-2"><span className="font-medium">{t('settings.backup.report')}</span><Badge tone={report.dryRun ? 'amber' : 'green'}>{report.dryRun ? t('settings.backup.dryRun') : `${t('settings.backup.applied')} ✓`}</Badge></div>
      {rows.length === 0 ? <p className="text-sm text-slate-500">{t('settings.backup.noChanges')}</p> : (
        <div className="overflow-x-auto"><table className="tbl"><tbody>
          {rows.map((s) => <tr key={s}><th scope="row" className="text-left font-medium">{t(`settings.backup.section.${s}`)}</th><td>{report.counts[s].created} {t('settings.backup.created')}</td><td>{report.counts[s].updated} {t('settings.backup.updated')}</td></tr>)}
        </tbody></table></div>
      )}
      {report.warnings.length > 0 && <div><div className="label">{t('settings.backup.warnings')} ({report.warnings.length})</div><ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-auto pl-5 text-sm text-amber-700 dark:text-amber-300">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      {report.errors.length > 0 && <div role="alert"><div className="label">{t('settings.backup.errors')} ({report.errors.length})</div><ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-auto pl-5 text-sm text-red-700 dark:text-red-300">{report.errors.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    </div>
  );
}
