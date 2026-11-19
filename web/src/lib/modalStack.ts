/**
 * Stack of open overlays (modals, confirm dialogs, command palette). Only the top one may react to Escape and trap focus;
 * everything beneath it, including the app root, is hidden from assistive technology and made inert.
 * Overlays are rendered into document.body (portals), so #root can be inert without hiding them.
 */
interface Layer { el: HTMLElement | null }
const layers: Layer[] = [];

function hide(el: HTMLElement, on: boolean) {
  if (on) { el.setAttribute('aria-hidden', 'true'); el.setAttribute('inert', ''); } else { el.removeAttribute('aria-hidden'); el.removeAttribute('inert'); }
}
function sync() {
  const root = document.getElementById('root');
  if (root) hide(root, layers.length > 0);
  layers.forEach((l, i) => { if (l.el) hide(l.el, i < layers.length - 1); });
}

export interface LayerHandle { isTop: () => boolean; release: () => void }
/** Register an overlay element as the new top layer. */
export function pushLayer(el: HTMLElement | null): LayerHandle {
  const layer: Layer = { el };
  layers.push(layer);
  sync();
  return {
    isTop: () => layers[layers.length - 1] === layer,
    release: () => { const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1); if (layer.el) hide(layer.el, false); sync(); },
  };
}

/** Is any dialog open (registered here or marked aria-modal, like the mobile menu)? Global shortcuts stay quiet then. */
export const hasOpenLayer = (): boolean => layers.length > 0 || !!document.querySelector('[role="dialog"][aria-modal="true"]');
