import { describe, expect, it } from 'vitest';
import { otlpPayload } from '../../src/server/telemetry';

describe('otlpPayload', () => {
  it('maps spans, attribute types and error status to OTLP JSON', () => {
    const p = otlpPayload([{ name: 'monitor.check', start: 1000, end: 1250, attrs: { 'monitor.id': 7, 'check.ok': false, 'monitor.type': 'http', ratio: 0.5 }, error: 'timeout: slow' }], 'pulsewatch');
    const s = p.resourceSpans[0].scopeSpans[0].spans[0];
    expect(s.traceId).toHaveLength(32);
    expect(s.spanId).toHaveLength(16);
    expect(s.startTimeUnixNano).toBe('1000000000');
    expect(s.endTimeUnixNano).toBe('1250000000');
    expect(s.status).toEqual({ code: 2, message: 'timeout: slow' });
    expect(s.attributes).toContainEqual({ key: 'monitor.id', value: { intValue: '7' } });
    expect(s.attributes).toContainEqual({ key: 'check.ok', value: { boolValue: false } });
    expect(s.attributes).toContainEqual({ key: 'ratio', value: { doubleValue: 0.5 } });
  });
});
