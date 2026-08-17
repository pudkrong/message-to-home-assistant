import { DynamicModule, Module } from '@nestjs/common';
import {
  AZURE_SERVICE_BUS_OPTIONS,
  AzureServiceBusOptions,
  AzureServiceBusService,
} from './azure-service-bus.service';
import { MESSAGE_TRANSPORT } from './messaging.constants';

/**
 * Azure Service Bus flavour of the messaging module.
 *
 * Owns the wiring for the Service Bus backend: registers
 * {@link AzureServiceBusService} with the caller's options and
 * exposes it behind the provider-agnostic {@link MESSAGE_TRANSPORT}
 * token so consumers stay broker-blind.
 *
 * Select this module explicitly (either directly or via
 * {@link MessagingModule} `provider: 'azure'`) when Service Bus is
 * the chosen backend; the KubeMQ subtree is then never registered.
 */
@Module({})
export class AzureServiceBusModule {
  static forRoot(options: AzureServiceBusOptions): DynamicModule {
    return {
      module: AzureServiceBusModule,
      providers: [
        { provide: AZURE_SERVICE_BUS_OPTIONS, useValue: options },
        AzureServiceBusService,
        { provide: MESSAGE_TRANSPORT, useExisting: AzureServiceBusService },
      ],
      exports: [MESSAGE_TRANSPORT],
    };
  }
}
