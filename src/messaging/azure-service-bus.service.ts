import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import {
  ServiceBusClient,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { DefaultAzureCredential } from '@azure/identity';
import { MessageHandler, MessageTransport } from './messaging.transport';

/** DI token for Azure Service Bus adapter options. Wired by {@link AzureServiceBusModule.forRoot}. */
export const AZURE_SERVICE_BUS_OPTIONS = Symbol('AZURE_SERVICE_BUS_OPTIONS');

/**
 * Options for the Azure Service Bus backend.
 *
 * Authentication is decided as follows:
 *   1. If `connectionString` is provided it is used directly.
 *   2. Otherwise a fully-qualified namespace is required and the
 *      {@link https://learn.microsoft.com/azure/identity/ | Azure Identity}
 *      SDK is used (DefaultAzureCredential, which picks managed identity,
 *      env vars, az cli, etc. automatically).
 */
export interface AzureServiceBusOptions {
  /** Full Service Bus connection string. Takes precedence when set. */
  connectionString?: string;
  /** Fully-qualified namespace, e.g. `mysbus.servicebus.windows.net`. */
  namespace?: string;
  /** Name of the queue to subscribe to. */
  queue: string;
  /**
   * Receive mode. `peekLock` (default) gives at-least-once delivery
   * via `complete()` / `abandon()`. `receiveAndDelete` removes
   * messages immediately on receipt.
   */
  receiveMode?: 'peekLock' | 'receiveAndDelete';
  /**
   * Optional session id. When set, only messages with this sessionId
   * are received. Empty/undefined means static receive (no sessions).
   */
  sessionId?: string;
}

/**
 * Azure Service Bus adapter implementing {@link MessageTransport}.
 *
 * Subscribes to a single queue and forwards each message's `body` to
 * every registered handler. Delivery semantics follow the queue's
 * receive mode:
 *
 *   - `peekLock` (default): at-least-once. A handler failure abandons
 *     the message so the broker re-delivers it; success completes it.
 *   - `receiveAndDelete`: messages are removed on receipt; handler
 *     failures are logged but not retried.
 */
@Injectable()
export class AzureServiceBusService
  implements MessageTransport, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(AzureServiceBusService.name);
  private readonly handlers: MessageHandler[] = [];
  private client: ServiceBusClient | undefined;
  private receiver:
    | ReturnType<ServiceBusClient['createReceiver']>
    | undefined;

  constructor(
    @Inject(AZURE_SERVICE_BUS_OPTIONS)
    private readonly options: AzureServiceBusOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.queue) {
      throw new Error(
        '[AzureServiceBus] queue is required (set SERVICE_BUS_QUEUE or pass options.queue)',
      );
    }

    const client = buildClient(this.options);
    this.client = client;

    const receiveMode: 'peekLock' | 'receiveAndDelete' =
      this.options.receiveMode === 'receiveAndDelete'
        ? 'receiveAndDelete'
        : 'peekLock';

    this.receiver = client.createReceiver(this.options.queue, {
      receiveMode,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    });

    this.receiver.subscribe({
      processMessage: (msg) => this.dispatch(msg),
      processError: async (err) => {
        this.logger.error(
          `Service Bus receiver error: ${err.error?.message ?? err}`,
          err.error?.stack,
        );
      },
    });

    this.logger.log(
      `Subscribed to queue "${this.options.queue}" (receiveMode=${receiveMode})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.receiver?.close();
    } catch (err) {
      this.logger.warn(`Error closing receiver: ${(err as Error).message}`);
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

  private async dispatch(msg: ServiceBusReceivedMessage): Promise<void> {
    const body: unknown = msg.body;
    for (const handler of this.handlers) {
      try {
        await handler(body);
      } catch (err) {
        this.logger.error(
          `Handler failed for message id=${msg.messageId}: ${(err as Error).message}`,
          (err as Error).stack,
        );
        try {
          await this.receiver?.abandonMessage(msg);
        } catch (abandonErr) {
          this.logger.error(
            `Failed to abandon message: ${(abandonErr as Error).message}`,
          );
        }
        return;
      }
    }
    // peekLock: complete the message once all handlers succeed
    try {
      await this.receiver?.completeMessage(msg);
    } catch (err) {
      this.logger.warn(
        `Failed to complete message id=${msg.messageId}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Build a {@link ServiceBusClient} from the options. Connection
 * string wins; otherwise we use {@link DefaultAzureCredential} with
 * a fully-qualified namespace (managed identity, az cli, env vars,
 * etc.).
 */
function buildClient(options: AzureServiceBusOptions): ServiceBusClient {
  if (options.connectionString) {
    return new ServiceBusClient(options.connectionString);
  }
  if (!options.namespace) {
    throw new Error(
      '[AzureServiceBus] either connectionString or namespace must be provided',
    );
  }
  return new ServiceBusClient(options.namespace, new DefaultAzureCredential());
}
