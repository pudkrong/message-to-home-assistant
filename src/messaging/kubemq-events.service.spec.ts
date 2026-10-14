import type {
  EventsClient,
  EventsReceiveMessage,
  EventsReceiveMessageCallback,
  EventsSubscriptionResponse,
} from 'kubemq-js';
import { firstValueFrom } from 'rxjs';
import {
  decodeKubeMqBody,
  KubeMqEventsService,
  normalizeKubeMqPayload,
} from './kubemq-events.service';

describe('KubeMQ payload decoding', () => {
  describe('decodeKubeMqBody', () => {
    it('parses UTF-8 JSON', () => {
      expect(decodeKubeMqBody(new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 });
    });

    it('returns the empty string when the body is empty', () => {
      expect(decodeKubeMqBody(new Uint8Array())).toBe('');
    });

    it('accepts the string body form returned by kubemq-js v1.4', () => {
      expect(decodeKubeMqBody('{"a":1}')).toEqual({ a: 1 });
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

describe('KubeMqEventsService observable subscription', () => {
  function makeService(client: EventsClient): KubeMqEventsService {
    const service = new KubeMqEventsService({
      address: 'localhost:50000',
      channel: 'events',
    });
    (service as unknown as { eventClient: EventsClient }).eventClient = client;
    return service;
  }

  it('parses callback messages and unsubscribes after the observer completes', async () => {
    let callback: EventsReceiveMessageCallback | undefined;
    const unsubscribe = jest.fn();
    const client = {
      subscribe: jest.fn((_request: unknown, onMessage: EventsReceiveMessageCallback) => {
        callback = onMessage;
        return Promise.resolve({ unsubscribe } as unknown as EventsSubscriptionResponse);
      }),
    } as unknown as EventsClient;
    const service = makeService(client);

    const resultPromise = firstValueFrom(service.eventSubscribe$<{ value: number }>('events'));
    callback?.(null, {
      id: 'event-1',
      channel: 'events',
      metadata: 'source=test',
      body: '{"value":42}',
      tags: new Map(),
    });

    await expect(resultPromise).resolves.toEqual({
      id: 'event-1',
      payload: { value: 42 },
      channel: 'events',
      metadata: 'source=test',
    });
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when teardown wins the asynchronous setup race', async () => {
    let resolveSubscribe!: (value: EventsSubscriptionResponse) => void;
    const unsubscribe = jest.fn();
    const client = {
      subscribe: jest.fn(
        () =>
          new Promise<EventsSubscriptionResponse>((resolve) => {
            resolveSubscribe = resolve;
          }),
      ),
    } as unknown as EventsClient;
    const service = makeService(client);
    const observer = service.eventSubscribe$('events').subscribe();

    observer.unsubscribe();
    resolveSubscribe({ unsubscribe } as unknown as EventsSubscriptionResponse);
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('recreates the client and retries after a subscription error', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    let callback!: EventsReceiveMessageCallback;
    const firstClient = {
      subscribe: jest.fn((_request: unknown, onMessage: EventsReceiveMessageCallback) => {
        callback = onMessage;
        return Promise.resolve({ unsubscribe: jest.fn() });
      }),
      close: jest.fn(),
    } as unknown as EventsClient;
    const secondClient = {
      subscribe: jest.fn(() => Promise.resolve({ unsubscribe: jest.fn() })),
      close: jest.fn(),
    } as unknown as EventsClient;
    const service = makeService(firstClient);
    const recreateClient = jest.fn(() => secondClient);
    (service as unknown as { createEventClient: () => EventsClient }).createEventClient =
      recreateClient;
    const observer = service.eventSubscribe$('events').subscribe();

    callback(new Error('connection dropped'), {} as EventsReceiveMessage);
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(recreateClient).toHaveBeenCalledTimes(1);
    expect(secondClient.subscribe).toHaveBeenCalledTimes(1);

    observer.unsubscribe();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
});
