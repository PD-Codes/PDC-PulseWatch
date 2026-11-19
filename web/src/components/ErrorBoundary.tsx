import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { useRouteError } from 'react-router-dom';
import { LocaleProvider, useT } from '../lib/i18n';
import { isChunkError, reloadOnce } from '../lib/reload';

function Crash({ error }: { error: Error }) {
  const t = useT();
  return (
    <div role="alert" className="mx-auto mt-24 max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">{t('shell.crash.title')}</h1>
      <p className="mt-2 text-sm text-slate-500">{t('shell.crash.body')}</p>
      <p className="mt-2 break-words font-mono text-xs text-slate-400">{error.message}</p>
      <div className="mt-4 flex justify-center gap-2">
        <button className="btn btn-primary" onClick={() => location.reload()}>{t('shell.crash.reload')}</button>
        <a className="btn no-underline" href="/">{t('shell.crash.home')}</a>
      </div>
    </div>
  );
}

/** Top-level error boundary. A missing lazy chunk (new deployment) reloads the page once instead of showing the error. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(e: Error, i: ErrorInfo) { console.error(e, i.componentStack); if (isChunkError(e)) reloadOnce(); }
  render() {
    if (!this.state.error) return this.props.children;
    // this sits above the app's own LocaleProvider, so the fallback brings one (browser/stored language)
    return <LocaleProvider><Crash error={this.state.error} /></LocaleProvider>;
  }
}

/** Error element of the data router: render errors inside the app reach it before they reach the boundary above. */
export function RouteCrash() {
  const raw = useRouteError();
  const error = raw instanceof Error ? raw : new Error(String(raw));
  useEffect(() => { console.error(raw); if (isChunkError(error)) reloadOnce(); }, [raw, error]);
  return <Crash error={error} />;
}
