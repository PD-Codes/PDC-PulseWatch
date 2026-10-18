import { EventEmitter } from 'node:events';

export type BusEvent =
  | { type: 'monitor'; monitorId: number; data: Record<string, unknown> }
  | { type: 'incident'; incidentId: number; monitorId: number | null; status: string }
  | { type: 'maintenance' }
  | { type: 'config'; entity: string; id?: number };

/** In-process event bus. In split api/worker deployments the api process feeds it by tailing the database. */
export class Bus extends EventEmitter {
  publish(e: BusEvent) { this.emit('event', e); }
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
