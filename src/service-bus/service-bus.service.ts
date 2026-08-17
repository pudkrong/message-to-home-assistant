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
import { SERVICE_BUS_CLIENT, SERVICE_BUS_OPTIONS } from './service-bus.constants';
import {
  ServiceBusMessageHandler,
  ServiceBusOptions,
} from './service-bus.types';

/**
 * Generic Service Bus subscriber. Consumers register a handler via
 * {@link ServiceBusMessageHandler} and the module takes care of
 * connection lifecycle, message dispatch and graceful shutdown.
 *
 * Intentionally agnostic of where the payload ends up - this module
 * can be reused by any NestJS app.
 */
@Injectable()
export class ServiceBusService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ServiceBusService.name);
  private readonly handlers: ServiceBusMessageHandler[] = [];
  private receiver: ReturnType<ServiceBusClient['createReceiver']> | undefined;

  constructor(
    @Inject(SERVICE_BUS_OPTIONS) private readonly options: ServiceBusOptions,
    @Inject(SERVICE_BUS_CLIENT) private readonly client: ServiceBusClient,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.queue) {
      throw new Error(
        '[ServiceBus] queue is required (set SERVICE_BUS_QUEUE or pass options.queue)',
      );
    }

    const receiveMode: 'peekLock' | 'receiveAndDelete' =
      this.options.receiveMode === 'receiveAndDelete'
        ? 'receiveAndDelete'
        : 'peekLock';

    this.receiver = this.client.createReceiver(this.options.queue, {
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
      await this.client.close();
    } catch (err) {
      this.logger.warn(`Error closing client: ${(err as Error).message}`);
    }
  }

  /**
   * Register a handler that will be invoked with the parsed `body`
   * of every inbound message. Each handler is awaited in order.
   * Errors in a handler cause the message to be abandoned (peekLock)
   * so the broker re-delivers it.
   */
  onMessage(handler: ServiceBusMessageHandler): void {
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
