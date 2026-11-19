import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { ErrorBoundary, RouteCrash } from './components/ErrorBoundary';
import { UiProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { reloadOnce } from './lib/reload';
import './index.css';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } },
});

// A data router (instead of <BrowserRouter>) is what lets pages block navigation while a form has unsaved input (useUnsavedChangesGuard).
const router = createBrowserRouter([{ path: '*', element: <App />, ErrorBoundary: RouteCrash }]);

// After a deployment the old hashed chunks are gone: reload once to get the new build (a flag keeps this from looping)
window.addEventListener('vite:preloadError', (e) => { if (reloadOnce()) e.preventDefault(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <UiProvider>
            <RouterProvider router={router} />
          </UiProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// One service worker (and cache) per build: the build id in the URL makes the browser install the new worker, which removes the old caches
if ('serviceWorker' in navigator && import.meta.env.PROD) window.addEventListener('load', () => void navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(__APP_BUILD__)}`).catch(() => {}));
