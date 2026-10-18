import type { Ctx } from '../context';
import { parseJson } from '../db';

/** In split deployments the API process has no scheduler; it follows state changes written by the worker so SSE clients stay live. */
export class Tailer {
  private timer?: NodeJS.Timeout;
  private since = new Date();
  constructor(private ctx: Ctx) {}

  start() {
    this.timer = setInterval(() => void this.poll(), 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  private async poll() {
    const from = this.since;
    this.since = new Date(Date.now() - 200);
    try {
      const rows = await this.ctx.db.selectFrom('monitor_state').selectAll().where('updated_at', '>', from).limit(2000).execute();
      for (const r of rows) {
        const recent = parseJson<[number, number, number | null][]>(r.recent, []);
        this.ctx.bus.publish({ type: 'monitor', monitorId: r.monitor_id, data: { id: r.monitor_id, status: r.status, overlay: r.overlay, latencyMs: r.last_latency_ms, errorKind: r.last_error_kind, message: r.last_message, ts: r.last_check_at?.toISOString(), beat: recent[recent.length - 1] ?? null, flapping: !!r.flapping, statusSince: r.status_since?.toISOString(), anomalyFlagged: !!parseJson<{ flagged?: boolean }>(r.anomaly, {}).flagged } });
      }
    } catch (e) { this.ctx.log.warn({ err: e }, 'state tail failed'); }
  }
}
