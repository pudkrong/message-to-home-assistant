import type { ModuleMetadata } from '@nestjs/common';
import type { AzureServiceBusOptions } from './azure-service-bus.service';
import type { KubeMqEventsOptions } from './kubemq-events.service';

/** Supported broker providers. Add new names here when introducing a new adapter. */
export type MessagingProvider = 'azure' | 'kubemq';

/**
 * Options forwarded to {@link MessagingModule}.
 *
 * `provider` selects the backend. The matching provider-specific
 * block must be supplied (and others can be omitted). One and only
 * one backend is chosen - `MessagingModule` validates the selection
 * and wires in either {@link AzureServiceBusModule} or
 * {@link KubeMqEventsModule}, never both. The bridge module keeps
 * one canonical wiring shape so callers (env-based or explicit)
 * just describe what they want:
 *
 * ```ts
 * MessagingModule.forRoot({
 *   provider: 'kubemq',
 *   kubemq: { address: 'localhost:50000', channel: 'my-events' },
 * });
 * ```
 */
export interface MessagingOptions {
  provider: MessagingProvider;
  /** Required when {@link provider} is `'azure'`. */
  azure?: AzureServiceBusOptions;
  /** Required when {@link provider} is `'kubemq'`. */
  kubemq?: KubeMqEventsOptions;
}

/** Factory options accepted by {@link MessagingModule.forRootAsync}. */
export interface MessagingAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<MessagingOptions> | MessagingOptions;
  inject?: any[];
  extraProviders?: any[];
}
