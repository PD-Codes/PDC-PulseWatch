import { randomUUID } from 'node:crypto';

/** One check result as the server's /api/probe/v1/results expects it. */
export interface Result { id: string; monitorId: number; ts: string; ok: boolean; latencyMs: number | null; errorKind: string | null; message: string | null }
export interface ResultBatch { results: Result[]; sentAt: string; skipped: number }

/**
 * Results waiting for delivery. Every result has an id, so a batch whose response got lost can be sent again without being
 * stored twice; `sentAt` lets the server correct a wrong probe clock; `skipped` reports checks dropped under overload.
 */
export class Outbox {
  queue: Result[] = [];
  /** Checks skipped because the probe was overloaded, not yet reported to the server. */
  skipped = 0;
  private seq = 0;
  private readonly boot = randomUUID().slice(0, 8);

  constructor(
    private send: (batch: ResultBatch, timeoutMs: number) => Promise<void>,
    private log: (level: string, msg: string, extra?: Record<string, unknown>) => void = () => {},
    private opts: { max?: number; batch?: number; timeoutMs?: number } = {},
  ) {}

  private get max() { return this.opts.max ?? 5000; }
  private get batchSize() { return this.opts.batch ?? 500; }

  push(r: Omit<Result, 'id'>): void {
    this.queue.push({ id: `${this.boot}-${++this.seq}`, ...r });
    if (this.queue.length > this.max) this.queue = this.queue.slice(-this.max); // server unreachable for long: keep the newest
  }

  noteSkipped(n = 1): void { this.skipped += n; }

  private inflight?: Promise<boolean>;

  /** Send one batch. Returns false when it could not be delivered (it stays queued). A flush still running is joined, never overlapped. */
  flush(timeoutMs = this.opts.timeoutMs ?? 15_000): Promise<boolean> {
    if (!this.inflight) this.inflight = this.flushOnce(timeoutMs).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async flushOnce(timeoutMs: number): Promise<boolean> {
    if (!this.queue.length && !this.skipped) return true;
    const batch = this.queue.splice(0, this.batchSize);
    const skipped = this.skipped;
    try {
      await this.send({ results: batch, sentAt: new Date().toISOString(), skipped }, timeoutMs);
      this.skipped -= skipped;
      return true;
    } catch (e) {
      this.queue = [...batch, ...this.queue].slice(-this.max); // retry with the next flush
      this.log('warn', 'could not deliver results', { error: (e as Error).message, queued: this.queue.length });
      return false;
    }
  }

  /** Send everything that is queued, batch by batch, until done, a delivery fails or the deadline passes. */
  async drain(deadline: number): Promise<{ sent: number; left: number }> {
    const before = this.queue.length;
    while ((this.queue.length || this.skipped) && Date.now() < deadline) {
      if (!(await this.flush(Math.max(1000, Math.min(this.opts.timeoutMs ?? 15_000, deadline - Date.now()))))) break;
    }
    return { sent: before - this.queue.length, left: this.queue.length };
  }
}
