import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './azure-service-bus.constants';
import { AzureServiceBusService } from './azure-service-bus.service';
import { MESSAGE_TRANSPORT } from './messaging.constants';

/**
 * Azure Service Bus flavour of the messaging module.
 *
 * Owns the wiring for the Service Bus backend: registers
 * {@link AzureServiceBusService} and exposes it behind the
 * provider-agnostic {@link MESSAGE_TRANSPORT} token so consumers
 * stay broker-blind. Options arrive through the `forRoot` /
 * `forRootAsync` entry points inherited from
 * `ConfigurableModuleClass`.
 *
 * Select this module explicitly (either directly or via
 * {@link MessagingModule} `provider: 'azure'`) when Service Bus is
 * the chosen backend; the KubeMQ subtree is then never registered.
 */
@Module({
  providers: [
    AzureServiceBusService,
    { provide: MESSAGE_TRANSPORT, useExisting: AzureServiceBusService },
  ],
  exports: [MESSAGE_TRANSPORT],
})
export class AzureServiceBusModule extends ConfigurableModuleClass {}
