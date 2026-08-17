import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { KubeMQClient, createConsoleLogger } from 'kubemq-js';
import { MessageHandler, MessageTransport } from './messaging.transport';
import { MODULE_OPTIONS_TOKEN } from './kubemq-events.constants';

/**
 * Options for the KubeMQ Events adapter.
 *
 * `address` is a `host:port` string (e.g. `localhost:50000`).
 * All other fields map directly to `kubemq-js` {@link ClientOptions}.
 * The producer side is assumed to send UTF-8-encoded JSON, which
 * matches the existing Service Bus payload contract.
 */
export interface KubeMqEventsOptions {
  /** KubeMQ broker address in `host:port` format. */
  address: string;
  /** Event channel to subscribe to. */
  channel: string;
  /** Auth token (or a kubemq-js CredentialProvider instance). */
  credentials?: string;
  /** Enable TLS. Pass `true` for defaults or an object for advanced config. */
  tls?: boolean;
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
  /**
   * gRPC keepalive interval in milliseconds. KubeMQ brokers
   * sometimes reject connections that ping too often with
   * "excess pings" and increase the interval on their own; raise
   * this to a high value if you see that warning.
   * Defaults to 30000 when omitted (the broker default is ~10s).
   */
  keepalivePingMs?: number;
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
  private client: KubeMQClient | undefined;
  private subscription: { cancel(): void } | undefined;
  private readonly handlers: MessageHandler[] = [];

  async onModuleInit(): Promise<void> {
    if (!this.options.address) {
      throw new Error('[KubeMQEvents] KUBEMQ_ADDRESS is required');
    }
    if (!this.options.channel) {
      throw new Error('[KubeMQEvents] channel is required');
    }

    // Default keepalive is 30s - the broker's built-in default is
    // 10s which trips "excess pings" on shared brokers. Override
    // via KUBEMQ_KEEPALIVE_PING_MS env if you need different
    // behaviour.
    const pingMs = this.options.keepalivePingMs ?? 30_000;

    this.client = await KubeMQClient.create({
      address: this.options.address,
      logger: createConsoleLogger('info'),
      keepalive: {
        timeMs: pingMs,
        timeoutMs: 10_000,
        permitWithoutCalls: false,
      },
      ...(this.options.credentials !== undefined
        ? { credentials: this.options.credentials }
        : {}),
      ...(this.options.tls !== undefined ? { tls: this.options.tls } : {}),
      ...(this.options.clientId !== undefined
        ? { clientId: this.options.clientId }
        : {}),
    });

    this.subscription = this.client.subscribeToEvents({
      channel: this.options.channel,
      ...(this.options.group !== undefined
        ? { group: this.options.group }
        : {}),
      onEvent: (event) => {
        const body = decodeKubeMqBody(event.body);
        const normalized = normalizeKubeMqPayload(body);
        for (const handler of this.handlers) {
          // Run sequentially so a slow handler cannot reorder
          // delivery within a single event stream.
          void this.invoke(handler, normalized, event);
        }
      },
      onError: (err) => {
        this.logger.error(`KubeMQ subscription error: ${err.message}`, err.stack);
      },
    });

    const groupDesc = this.options.group
      ? ` (group=${this.options.group})`
      : '';
    this.logger.log(
      `Subscribed to channel "${this.options.channel}"${groupDesc} on ${this.options.address}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      this.subscription?.cancel();
    } catch (err) {
      this.logger.warn(`Error cancelling subscription: ${(err as Error).message}`);
    }
    try {
      await this.client?.close();
    } catch (err) {
      this.logger.warn(`Error closing client: ${(err as Error).message}`);
    }
  }

  registerHandler(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: KubeMqEventsOptions) {}

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
 * UTF-8 JSON (matching the Service Bus v1 contract); fall back to
 * the raw string if parsing fails so a malformed payload is still
 * observable downstream.
 */
export function decodeKubeMqBody(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
