import { DynamicModule, Module } from '@nestjs/common';
import {
  KUBEMQ_EVENTS_OPTIONS,
  KubeMqEventsOptions,
  KubeMqEventsService,
} from './kubemq-events.service';
import { MESSAGE_TRANSPORT } from './messaging.constants';

/**
 * KubeMQ Events flavour of the messaging module.
 *
 * Owns the wiring for the KubeMQ backend: registers
 * {@link KubeMqEventsService} with the caller's options and exposes
 * it behind the provider-agnostic {@link MESSAGE_TRANSPORT} token so
 * consumers stay broker-blind.
 *
 * Select this module explicitly (either directly or via
 * {@link MessagingModule} `provider: 'kubemq'`) when KubeMQ is the
 * chosen backend; the Azure Service Bus subtree is then never
 * registered.
 */
@Module({})
export class KubeMqEventsModule {
  static forRoot(options: KubeMqEventsOptions): DynamicModule {
    return {
      module: KubeMqEventsModule,
      providers: [
        { provide: KUBEMQ_EVENTS_OPTIONS, useValue: options },
        KubeMqEventsService,
        { provide: MESSAGE_TRANSPORT, useExisting: KubeMqEventsService },
      ],
      exports: [MESSAGE_TRANSPORT],
    };
  }
}
