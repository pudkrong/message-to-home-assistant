import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './kubemq-events.constants';
import { KubeMqEventsService } from './kubemq-events.service';
import { MESSAGE_TRANSPORT } from './messaging.constants';

/**
 * KubeMQ Events flavour of the messaging module.
 *
 * Owns the wiring for the KubeMQ backend: registers
 * {@link KubeMqEventsService} and exposes it behind the
 * provider-agnostic {@link MESSAGE_TRANSPORT} token so consumers
 * stay broker-blind. Options arrive through the `forRoot` /
 * `forRootAsync` entry points inherited from
 * `ConfigurableModuleClass`.
 *
 * Select this module explicitly (either directly or via
 * {@link MessagingModule} `provider: 'kubemq'`) when KubeMQ is the
 * chosen backend; the Azure Service Bus subtree is then never
 * registered.
 */
@Module({
  providers: [
    KubeMqEventsService,
    { provide: MESSAGE_TRANSPORT, useExisting: KubeMqEventsService },
  ],
  exports: [MESSAGE_TRANSPORT],
})
export class KubeMqEventsModule extends ConfigurableModuleClass {}
