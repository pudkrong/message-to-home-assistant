import type { ModuleMetadata, Type } from '@nestjs/common';
import type { ServiceBusClient } from '@azure/service-bus';

/**
 * Options for the {@link ServiceBusModule}.
 *
 * Authentication is decided as follows:
 *   1. If `connectionString` is provided it is used directly.
 *   2. Otherwise a fully-qualified namespace is required and the
 *      {@link https://learn.microsoft.com/azure/identity/ | Azure Identity}
 *      SDK is used (DefaultAzureCredential, which picks managed identity,
 *      env vars, az cli, etc. automatically).
 */
export interface ServiceBusOptions {
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

/** Factory options accepted by {@link ServiceBusModule.forRootAsync}. */
export interface ServiceBusModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<ServiceBusOptions> | ServiceBusOptions;
  inject?: any[];
  extraProviders?: any[];
}

/**
 * Shape invoked by the service whenever a message arrives. Consumers
 * register handlers with {@link ServiceBusService.onMessage}.
 */
export type ServiceBusMessageHandler = (body: unknown) => Promise<void> | void;
