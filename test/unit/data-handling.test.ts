import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, checkTimeZone, dayStart, localDate, localDays, recentDays, startOfLocalDay } from '../../src/server/tz';
import { splitStatements } from '../../src/server/db/migrate';
import { deleteInBatches } from '../../src/server/jobs/housekeeping';
import { sseWriter, type SseSink } from '../../src/server/routes/system';
import { clockOffset } from '../../src/server/routes/probes';
import { Outbox, type ResultBatch } from '../../src/probe/outbox';

const H = 3_600_000;

describe('time zone days', () => {
  it('validates zone names', () => {
    expect(checkTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(() => checkTimeZone('Mars/Olympus', 'PW_TIMEZONE')).toThrow(/PW_TIMEZONE: unknown time zone "Mars\/Olympus"/);
  });

  it('counts UTC days like before', () => {
    expect(dayStart('UTC', '2026-11-19').toISOString()).toBe('2026-11-19T00:00:00.000Z');
    expect(localDate('UTC', Date.UTC(2026, 10, 19, 23, 59))).toBe('2026-11-19');
    expect(recentDays('UTC', 3, new Date('2026-11-19T12:00:00Z'))).toEqual({ since: new Date('2026-11-17T00:00:00Z'), dates: ['2026-11-17', '2026-11-18', '2026-11-19'] });
  });

  it('knows days of 23 and 25 hours around the DST changes', () => {
    const tz = 'Europe/Berlin';
    expect(dayStart(tz, '2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(dayStart(tz, '2026-03-30').getTime() - dayStart(tz, '2026-03-29').getTime()).toBe(23 * H);
    expect(dayStart(tz, '2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(dayStart(tz, '2026-10-26').getTime() - dayStart(tz, '2026-10-25').getTime()).toBe(25 * H);
    expect(localDate(tz, new Date('2026-10-25T22:59:59Z'))).toBe('2026-10-25');
    expect(localDate(tz, new Date('2026-10-25T23:00:00Z'))).toBe('2026-10-26');
    expect(startOfLocalDay(tz, new Date('2026-07-01T21:59:00Z')).toISOString()).toBe('2026-06-30T22:00:00.000Z');
    const days = localDays(tz, new Date('2026-10-24T23:30:00Z'), new Date('2026-10-26T01:00:00Z'));
    expect(days.map((d) => [d.date, d.start.toISOString(), (d.end.getTime() - d.start.getTime()) / H])).toEqual([
      ['2026-10-25', '2026-10-24T22:00:00.000Z', 25], ['2026-10-26', '2026-10-25T23:00:00.000Z', 24],
    ]);
  });

  it('starts a day whose midnight does not exist at the first local minute of it', () => {
    // Chile moves from 00:00 to 01:00 on 2026-09-06
    expect(dayStart('America/Santiago', '2026-09-06').toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(dayStart('Asia/Kolkata', '2026-01-01').toISOString()).toBe('2025-12-31T18:30:00.000Z');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('splitStatements', () => {
  it('splits at top-level semicolons and reports the line of each statement', () => {
    const text = "-- head; comment\nCREATE TABLE a (x VARCHAR(3) DEFAULT ';');\n\n/* block; */ ALTER TABLE a ADD COLUMN `y;` INT;\n# tail;\nSELECT \"it\\\"s;\"";
    expect(splitStatements(text)).toEqual([
      { sql: "CREATE TABLE a (x VARCHAR(3) DEFAULT ';')", line: 2 },
      { sql: 'ALTER TABLE a ADD COLUMN `y;` INT', line: 4 },
      { sql: 'SELECT "it\\"s;"', line: 6 },
    ]);
    expect(splitStatements('-- only a comment;\n')).toEqual([]);
  });
});

describe('deleteInBatches', () => {
  it('repeats a limited DELETE until a batch comes back short', async () => {
    let left = 25;
    const limits: number[] = [];
    const r = await deleteInBatches(async (n) => { limits.push(n); const d = Math.min(n, left); left -= d; return { numDeletedRows: BigInt(d) }; }, { batch: 10, pauseMs: 0 });
    expect(r).toEqual({ deleted: 25, batches: 3 });
    expect(limits).toEqual([10, 10, 10]);
  });
});

/** A writable that reports a full buffer once `capacity` bytes are pending, like a socket to a slow client. */
class FakeStream extends EventEmitter implements SseSink {
  chunks: string[] = []; writableLength = 0; ended = false; destroyed = false;
  constructor(private capacity: number) { super(); }
  write(c: string) { this.chunks.push(c); this.writableLength += Buffer.byteLength(c); return this.writableLength < this.capacity; }
  drain() { this.writableLength = 0; this.emit('drain'); }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

describe('sseWriter', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('holds events while the client buffer is full and sends them on drain', () => {
    const s = new FakeStream(10);
    const w = sseWriter(s, { maxBuffered: 1000 });
    w.write('aaaaaaaaaaaa'); // fills the buffer: write() returned false
    w.write('b'); w.write('c');
    expect(s.chunks).toEqual(['aaaaaaaaaaaa']);
    s.drain();
    expect(s.chunks).toEqual(['aaaaaaaaaaaa', 'bc']);
    expect(w.closed).toBe(false);
  });

  it('drops a client that buffers more than the limit', () => {
    const onClose = vi.fn();
    const s = new FakeStream(10);
    const w = sseWriter(s, { maxBuffered: 50, onClose });
    w.write('x'.repeat(20));
    for (let i = 0; i < 5; i++) w.write('y'.repeat(10));
    expect(w.closed).toBe(true);
    expect(s.destroyed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    w.write('late'); // ignored after close
    expect(s.chunks).toHaveLength(1);
  });

  it('drops a client that does not drain in time', () => {
    vi.useFakeTimers();
    const s = new FakeStream(5);
    const w = sseWriter(s, { drainTimeoutMs: 30_000 });
    w.write('123456');
    vi.advanceTimersByTime(29_000);
    expect(w.closed).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(w.closed).toBe(true);
    expect(s.destroyed).toBe(true);
  });

  it('ends gracefully when closed by the server', () => {
    const s = new FakeStream(100);
    const w = sseWriter(s);
    w.write('hello');
    w.close();
    expect(s.ended).toBe(true);
    expect(s.destroyed).toBe(false);
  });
});

describe('probe clock offset', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  it('uses the clock the probe reports, ignoring transit-sized differences', () => {
    expect(clockOffset(now, '2026-11-19T11:50:00Z', [])).toBe(600_000);
    expect(clockOffset(now, '2026-11-19T12:05:00Z', [])).toBe(-300_000);
    expect(clockOffset(now, '2026-11-19T11:59:59Z', [])).toBe(0);
  });
  it('corrects old probes only when their results lie in the future', () => {
    expect(clockOffset(now, undefined, [{ monitorId: 1, ok: true, ts: '2026-11-19T12:10:00Z' }, { monitorId: 1, ok: true, ts: '2026-11-19T12:09:00Z' }])).toBe(-600_000);
    expect(clockOffset(now, undefined, [{ monitorId: 1, ok: true, ts: '2026-11-19T10:00:00Z' }])).toBe(0); // a backlog, not a clock
    expect(clockOffset(now, undefined, [{ monitorId: 1, ok: true }])).toBe(0);
  });
});

describe('probe outbox', () => {
  const result = (i: number) => ({ monitorId: 1, ts: new Date(1_700_000_000_000 + i).toISOString(), ok: true, latencyMs: i, errorKind: null, message: null });

  it('drains the whole backlog in batches with unique ids, the probe clock and skipped runs', async () => {
    const sent: ResultBatch[] = [];
    const box = new Outbox(async (b) => { sent.push(b); }, () => {}, { batch: 500 });
    for (let i = 0; i < 1234; i++) box.push(result(i));
    box.noteSkipped(3);
    const r = await box.drain(Date.now() + 5000);
    expect(r).toEqual({ sent: 1234, left: 0 });
    expect(sent.map((b) => b.results.length)).toEqual([500, 500, 234]);
    expect(new Set(sent.flatMap((b) => b.results.map((x) => x.id))).size).toBe(1234);
    expect(sent[0].skipped).toBe(3);
    expect(sent[1].skipped).toBe(0);
    expect(Date.parse(sent[0].sentAt)).toBeGreaterThan(Date.now() - 5000);
    expect(box.skipped).toBe(0);
  });

  it('keeps a failed batch (with its ids) for the next attempt and stops draining', async () => {
    let fail = true;
    const sent: ResultBatch[] = [];
    const box = new Outbox(async (b) => { if (fail) throw new Error('offline'); sent.push(b); }, () => {}, { batch: 2 });
    for (let i = 0; i < 5; i++) box.push(result(i));
    box.noteSkipped(2);
    const first = await box.drain(Date.now() + 5000);
    expect(first).toEqual({ sent: 0, left: 5 });
    const ids = box.queue.map((r) => r.id);
    fail = false;
    await box.drain(Date.now() + 5000);
    expect(sent.flatMap((b) => b.results.map((r) => r.id))).toEqual(ids); // same ids again, so the server can drop duplicates
    expect(sent[0].skipped).toBe(2);
  });

  it('never runs two flushes at once, so skipped runs are reported once', async () => {
    const sent: ResultBatch[] = [];
    const box = new Outbox(async (b) => { await new Promise((r) => setTimeout(r, 30)); sent.push(b); }, () => {}, { batch: 10 });
    box.push(result(1));
    box.noteSkipped(3);
    const [a, b] = await Promise.all([box.flush(), box.flush()]); // e.g. the 5 s timer fires while a slow delivery still runs
    expect([a, b]).toEqual([true, true]);
    expect(sent).toHaveLength(1);
    expect(sent[0].skipped).toBe(3);
    expect(box.skipped).toBe(0);
    await box.flush();
    expect(sent).toHaveLength(1); // nothing left to send
  });

  it('stops at the deadline', async () => {
    const box = new Outbox(async () => { await new Promise((r) => setTimeout(r, 30)); }, () => {}, { batch: 1 });
    for (let i = 0; i < 50; i++) box.push(result(i));
    const r = await box.drain(Date.now() + 100);
    expect(r.left).toBeGreaterThan(0);
    expect(r.sent).toBeGreaterThan(0);
  });

  it('keeps only the newest results when the server is gone for long', () => {
    const box = new Outbox(async () => {}, () => {}, { max: 3 });
    for (let i = 0; i < 5; i++) box.push(result(i));
    expect(box.queue.map((r) => r.latencyMs)).toEqual([2, 3, 4]);
  });
});
