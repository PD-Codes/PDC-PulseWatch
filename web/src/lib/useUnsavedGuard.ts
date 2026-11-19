import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useConfirm } from '../components/ui';
import { useT } from './i18n';

/**
 * Warn before unsaved input is lost: in-app navigation (confirm dialog, needs the data router from main.tsx) and closing/reloading the tab.
 * Returns `release()`: call it right before a programmatic navigation after a successful save, because `dirty` is still true in that render.
 */
export function useUnsavedChangesGuard(dirty: boolean): () => void {
  const t = useT();
  const confirm = useConfirm();
  const released = useRef(false);
  useEffect(() => { released.current = false; }, [dirty]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !released.current && currentLocation.pathname !== nextLocation.pathname); // ?tab= changes stay on the page
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirm({ title: t('shell.unsaved.title'), body: t('shell.unsaved.body'), confirmLabel: t('shell.unsaved.leave'), danger: true }).then((ok) => { if (ok) blocker.proceed(); else blocker.reset(); });
  }, [blocker, confirm, t]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { if (released.current) return; e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  return useCallback(() => { released.current = true; }, []);
}
