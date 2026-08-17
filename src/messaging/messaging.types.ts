import type { ModuleMetadata } from '@nestjs/common';
import type { ServiceBusOptions } from '../service-bus/service-bus.types';
import type { KubeMqEventsOptions } from './kubemq-events.adapter';

/** Supported broker providers. Add new names here when introducing a new adapter. */
export type MessagingProvider = 'azure' | 'kubemq';

/**
 * Options forwarded to {@link MessagingModule}.
 *
 * `provider` selects the adapter. The matching provider-specific
 * block must be supplied (and others can be omitted). The bridge
 * module keeps one canonical wiring shape so callers (env-based or
 * explicit) just describe what they want:
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
  azure?: ServiceBusOptions;
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
