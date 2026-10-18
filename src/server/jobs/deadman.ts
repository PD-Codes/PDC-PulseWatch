import { httpRequest } from '../../core/http';
import { config } from '../config';
import type { Ctx } from '../context';

/** Dead-man's switch: ping an external service regularly so it can alert when PulseWatch itself stops. */
export class DeadMan {
  private timer?: NodeJS.Timeout;
  constructor(private ctx: Ctx, private alive: () => boolean) {}
  start() {
    if (!config.deadman.url) return;
    const ping = async () => {
      if (!this.alive()) return;
      try {
        const r = await httpRequest({ url: config.deadman.url!, signal: AbortSignal.timeout(10_000), guard: this.ctx.guard, maxBodyBytes: 1024 });
        if (r.status >= 400) this.ctx.log.warn({ status: r.status }, 'dead-man ping rejected');
      } catch (e) { this.ctx.log.warn({ err: (e as Error).message }, 'dead-man ping failed'); }
    };
    this.timer = setInterval(() => void ping(), config.deadman.intervalSec * 1000);
    this.timer.unref();
    void ping();
  }
  stop() { clearInterval(this.timer); }
}
