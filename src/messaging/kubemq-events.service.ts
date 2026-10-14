import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { EventsClient } from 'kubemq-js';
import type { Config, EventsSubscriptionResponse } from 'kubemq-js';
import { Observable, Subscription, catchError, retry, tap, throwError, timer } from 'rxjs';
import type { MessageHandler, MessageTransport } from './messaging.transport';
import { MODULE_OPTIONS_TOKEN } from './kubemq-events.constants';
import { randomUUID } from 'node:crypto';

/**
 * Options for the KubeMQ Events adapter.
 *
 * `address` is a `host:port` string (e.g. `localhost:50000`).
 * `authToken`, `clientId`, and `credentials` map to the v1.4
 * `kubemq-js` client configuration.
 * The producer side is assumed to send UTF-8-encoded JSON, which
 * matches the existing Service Bus payload contract.
 */
export interface KubeMqEventsOptions {
  /** KubeMQ broker address in `host:port` format. */
  address: string;
  /** Event channel to subscribe to. */
  channel: string;
  /** KubeMQ authentication token. */
  authToken?: string;
  /** TLS client certificate credentials supported by kubemq-js v1.4. */
  credentials?: Config['credentials'];
  /**
   * Delivery group. Subscribers sharing the same group + channel
   * load-balance messages. Different groups all receive every
   * event. Omit for the default load-balanced group.
   */
  group?: string;
  /**
   * Optional client identifier - surfaces in broker logs/metrics.
   * auto-generated if omitted.
   */
  clientId?: string;
}

/**
 * KubeMQ Events adapter implementing {@link MessageTransport}.
 *
 * Subscribes to a single channel and forwards each event's parsed
 * `body` to every registered handler. Events are fire-and-forget:
 * there is no ack/nack (KubeMQ events have no delivery guarantee
 * beyond "best effort"). Handler errors are logged but do not
 * cause re-delivery - callers that need at-least-once semantics
 * must use the Azure Service Bus queue adapter instead.
 */
@Injectable()
export class KubeMqEventsService implements MessageTransport, OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KubeMqEventsService.name);
  private eventClient: EventsClient | undefined;
  private subscription: Subscription | undefined;
  private readonly handlers: MessageHandler[] = [];

  /** Set once the app is shutting down; stops further reconnect attempts. */
  private closed = false;
  /** Cap for exponential backoff, anything above this is unnecessary. */
  private readonly maxReconnectDelayMs = 30_000;

  async onModuleInit(): Promise<void> {
    if (!this.options.address) {
      throw new Error('[KubeMQEvents] KUBEMQ_ADDRESS is required');
    }
    if (!this.options.channel) {
      throw new Error('[KubeMQEvents] channel is required');
    }

    this.eventClient = this.createEventClient();
    this.subscription = this.eventSubscribe$(
      this.options.channel,
      this.options.group !== undefined ? { group: this.options.group } : undefined,
    ).subscribe({
      next: (event) => {
        const normalized = normalizeKubeMqPayload(event.payload);
        for (const handler of this.handlers) {
          void this.invoke(handler, normalized, event);
        }
      },
      error: (err: unknown) => {
        this.logger.error(
          `KubeMQ event subscription stopped: ${errorMessage(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      },
    });

    const groupDesc = this.options.group ? ` (group=${this.options.group})` : '';
    this.logger.log(
      `Subscribed to channel "${this.options.channel}"${groupDesc} on ${this.options.address}`,
    );
  }

  /**
   * Adapt the v1.4 callback subscription to an observable. Each retry
   * creates a fresh EventsClient; the teardown also handles unsubscribe
   * racing the SDK's asynchronous subscription setup.
   */
  eventSubscribe$<T>(
    channel: string,
    options?: { group: string },
  ): Observable<{ id: string; payload: T; channel: string; metadata: string }> {
    const source$ = new Observable<{
      id: string;
      payload: T;
      channel: string;
      metadata: string;
    }>((subscriber) => {
      let cancelled = false;
      let eventSubscription: EventsSubscriptionResponse | undefined;
      const client = this.eventClient;

      if (this.closed || !client) {
        subscriber.complete();
        return;
      }

      this.logger.log(`KubeMQ event subscribes to ${channel}`);
      void client
        .subscribe(
          { channel, ...(options?.group ? { group: options.group } : {}) },
          (error, message) => {
            if (error) {
              subscriber.error(error);
              return;
            }
            if (!message) return;
            subscriber.next({
              id: message.id,
              payload: decodeKubeMqBody(message.body ?? '') as T,
              channel: message.channel,
              metadata: message.metadata,
            });
          },
        )
        .then((subscription) => {
          if (cancelled) {
            subscription.unsubscribe();
          } else {
            eventSubscription = subscription;
          }
        })
        .catch((error: unknown) => subscriber.error(error));

      return () => {
        cancelled = true;
        this.logger.log(`Unsubscribe KubeMQ event: ${channel}`);
        eventSubscription?.unsubscribe();
      };
    });

    return source$.pipe(
      catchError((error: unknown) => {
        this.logger.error(
          `KubeMQ event subscription [${channel}] error: ${errorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        return throwError(() => error);
      }),
      retry({
        delay: (_error: unknown, retryCount: number) => {
          const delayMs = Math.min(this.maxReconnectDelayMs, 1_000 * 2 ** (retryCount - 1));
          const jitterMs = Math.random() * 250;
          this.logger.warn(
            `Retrying KubeMQ event subscription [${channel}] in ${Math.round(delayMs + jitterMs)}ms`,
          );
          return timer(delayMs + jitterMs).pipe(
            tap(() => {
              this.eventClient?.close();
              if (!this.closed) this.eventClient = this.createEventClient();
            }),
          );
        },
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    try {
      this.subscription?.unsubscribe();
    } catch (err) {
      this.logger.warn(`Error cancelling subscription: ${(err as Error).message}`);
    }
    try {
      this.eventClient?.close();
    } catch (err) {
      this.logger.warn(`Error closing client: ${(err as Error).message}`);
    }
  }

  registerHandler(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: KubeMqEventsOptions) {}

  private createEventClient(): EventsClient {
    return new EventsClient({
      address: this.options.address,
      reconnectInterval: 0,
      ...(this.options.authToken !== undefined ? { authToken: this.options.authToken } : {}),
      ...(this.options.credentials !== undefined ? { credentials: this.options.credentials } : {}),
      ...(this.options.clientId !== undefined
        ? { clientId: this.options.clientId }
        : {
            clientId: `event-${randomUUID()}`,
          }),
    });
  }

  private async invoke(
    handler: MessageHandler,
    body: unknown,
    event: { id: string; channel: string },
  ): Promise<void> {
    try {
      await handler(body);
    } catch (err) {
      this.logger.error(
        `Handler failed for event id=${event.id} channel=${event.channel}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}

/**
 * Decode a KubeMQ event payload. The producer is expected to send
 * UTF-8 JSON as bytes or a string (matching the Service Bus v1 contract); fall back to
 * the raw string if parsing fails so a malformed payload is still
 * observable downstream.
 */
export function decodeKubeMqBody(bytes: Uint8Array | string): unknown {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8').decode(bytes);
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Translate the KubeMQ producer wire format into the canonical
 * {@link PayloadV1} shape the rest of the app speaks. Today this
 * is just `reportID` → `reportId` on the items inside `data`; new
 * field renames land here too, so handlers stay broker-agnostic.
 *
 * Pass-through when the body isn't shaped like a sensor payload -
 * validation lives in {@link isPayloadV1}; we don't reject here.
 */
export function normalizeKubeMqPayload(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj['data'])) return body;
  const data = (obj['data'] as unknown[]).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const it = item as Record<string, unknown>;
    if (typeof it['reportID'] === 'number' && it['reportId'] === undefined) {
      // Construct once with both keys populated; downstream
      // readers always look at `reportId`.
      return { ...it, reportId: it['reportID'] };
    }
    return item;
  });
  return { ...obj, data };
}
