import { Boxes, CalendarClock, Grid3x3, LayoutGrid, ListTree, Table } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DISPLAYS, type Display } from '../../lib/dashboardView';
import { useT } from '../../lib/i18n';
import { cx } from '../ui';

const ICON: Record<Display, LucideIcon> = { cards: LayoutGrid, groups: Boxes, table: Table, wall: Grid3x3, heatmap: CalendarClock };
const SEG = 'inline-flex items-center gap-1.5 px-2.5 py-2 text-sm';
const segTone = (on: boolean) => (on ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800');

/**
 * Segmented view picker plus the grouped switch. To keep the filter row on one line, only the active view shows its label (from sm);
 * the others and the grouped switch are icons (names in title and aria-label) until very wide screens.
 */
export function ViewSwitcher({ display, grouped, onDisplay, onGrouped }: { display: Display; grouped: boolean; onDisplay: (d: Display) => void; onGrouped: (g: boolean) => void }) {
  const t = useT();
  return (
    <div className="ml-auto flex items-center gap-2">
      {display !== 'groups' && (
        <button type="button" aria-pressed={grouped} onClick={() => onGrouped(!grouped)} title={t('dview.groupedTip')} aria-label={t('dview.grouped')}
          className={cx(SEG, 'rounded-lg border border-slate-300 dark:border-slate-700', segTone(grouped))}>
          <ListTree className="h-4 w-4" aria-hidden /><span className="hidden min-[1800px]:inline">{t('dview.grouped')}</span>
        </button>
      )}
      <div className="flex divide-x divide-slate-300 overflow-hidden rounded-lg border border-slate-300 dark:divide-slate-700 dark:border-slate-700" role="group" aria-label={t('dview.label')}>
        {DISPLAYS.map((d) => {
          const Icon = ICON[d];
          return (
            <button key={d} type="button" aria-pressed={display === d} aria-label={t(`dview.d.${d}`)} title={t(`dview.tip.${d}`)} onClick={() => onDisplay(d)} className={cx(SEG, segTone(display === d))}>
              <Icon className="h-4 w-4" aria-hidden /><span className={cx('hidden', display === d ? 'sm:inline' : 'min-[1800px]:inline')}>{t(`dview.d.${d}`)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
