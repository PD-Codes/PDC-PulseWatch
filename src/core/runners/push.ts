import type { Runner } from '../types';

/** Push (heartbeat) monitors are evaluated by the server from received pings; this runner only declares the form. */
export const pushRunner: Runner = {
  type: 'push', label: 'Push / heartbeat', category: 'Passive',
  fields: [
    { key: 'graceSeconds', label: 'Grace period (seconds)', kind: 'number', default: 60, min: 0, max: 86400, help: 'How long after the expected interval a ping may arrive before the monitor goes down.' },
  ],
  async run() {
    return { ok: false, errorKind: 'internal', message: 'Push monitors are evaluated by the scheduler' };
  },
};
