import { decodeKubeMqBody, normalizeKubeMqPayload } from './kubemq-events.service';

describe('KubeMQ payload decoding', () => {
  describe('decodeKubeMqBody', () => {
    it('parses UTF-8 JSON', () => {
      expect(decodeKubeMqBody(new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 });
    });

    it('returns the empty string when the body is empty', () => {
      expect(decodeKubeMqBody(new Uint8Array())).toBe('');
    });

    it('falls back to the raw string on invalid JSON', () => {
      expect(decodeKubeMqBody(new TextEncoder().encode('not-json'))).toBe('not-json');
    });
  });

  describe('normalizeKubeMqPayload', () => {
    it('passes a Service-Bus-shaped body through unchanged', () => {
      const body = {
        unitFactoryNumber: 'X',
        version: 1,
        timestamp: '2026-08-17T00:00:00.000Z',
        data: [{ reportId: 10116, value: 1 }],
      };
      expect(normalizeKubeMqPayload(body)).toEqual(body);
    });

    it('renames kubemq `reportID` to `reportId` on data items', () => {
      const body = {
        unitFactoryNumber: '0101-022001-111012',
        version: 1,
        timestamp: '2026-08-17T18:40:01.000Z',
        data: [
          {
            metadata: { configuration: { id: 10116 } },
            reportID: 10116,
            value: 40.8,
          },
          {
            metadata: { configuration: { id: 10122 } },
            reportID: 10122,
            value: 27,
          },
        ],
      };
      const out = normalizeKubeMqPayload(body) as { data: Array<Record<string, unknown>> };
      expect(out.data[0]).toMatchObject({
        reportID: 10116,
        reportId: 10116,
        value: 40.8,
        metadata: { configuration: { id: 10116 } },
      });
      expect(out.data[1]).toMatchObject({
        reportID: 10122,
        reportId: 10122,
        value: 27,
        metadata: { configuration: { id: 10122 } },
      });
      // Top-level fields preserved.
      expect(out).toMatchObject({
        unitFactoryNumber: '0101-022001-111012',
        version: 1,
        timestamp: '2026-08-17T18:40:01.000Z',
      });
    });

    it('does not overwrite an existing `reportId` field', () => {
      const body = {
        data: [{ reportId: 12, reportID: 12, value: 1 }],
      };
      const out = normalizeKubeMqPayload(body);
      expect(out).toEqual(body);
    });

    it('passes through a body without a `data` array', () => {
      const body = { hello: 'world' };
      expect(normalizeKubeMqPayload(body)).toEqual(body);
    });

    it('passes through non-object bodies', () => {
      expect(normalizeKubeMqPayload(null)).toBeNull();
      expect(normalizeKubeMqPayload(42)).toBe(42);
      expect(normalizeKubeMqPayload('text')).toBe('text');
    });
  });
});
