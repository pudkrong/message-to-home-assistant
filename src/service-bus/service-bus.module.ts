import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ServiceBusClient } from '@azure/service-bus';
import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusService } from './service-bus.service';
import {
  SERVICE_BUS_CLIENT,
  SERVICE_BUS_OPTIONS,
} from './service-bus.constants';
import {
  ServiceBusModuleAsyncOptions,
  ServiceBusOptions,
} from './service-bus.types';

/**
 * Build a {@link ServiceBusClient} from the options. Connection
 * string wins; otherwise we use {@link DefaultAzureCredential} with
 * a fully-qualified namespace (managed identity, az cli, env vars,
 * etc.).
 */
function buildClient(options: ServiceBusOptions): ServiceBusClient {
  if (options.connectionString) {
    return new ServiceBusClient(options.connectionString);
  }
  if (!options.namespace) {
    throw new Error(
      '[ServiceBus] either connectionString or namespace must be provided',
    );
  }
  return new ServiceBusClient(options.namespace, new DefaultAzureCredential());
}

@Module({})
export class ServiceBusModule {
  /** Register with a static options object. */
  static forRoot(options: ServiceBusOptions): DynamicModule {
    return {
      module: ServiceBusModule,
      providers: [
        { provide: SERVICE_BUS_OPTIONS, useValue: options },
        {
          provide: SERVICE_BUS_CLIENT,
          useFactory: (opts: ServiceBusOptions) => buildClient(opts),
          inject: [SERVICE_BUS_OPTIONS],
        },
        ServiceBusService,
      ],
      exports: [ServiceBusService],
    };
  }

  /** Register from a factory that returns the options. */
  static forRootAsync(asyncOptions: ServiceBusModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: SERVICE_BUS_OPTIONS,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      },
      {
        provide: SERVICE_BUS_CLIENT,
        useFactory: (opts: ServiceBusOptions) => {
          const logger = new Logger('ServiceBusFactory');
          logger.log(
            opts.connectionString
              ? 'Connecting with connection string'
              : `Connecting with managed identity to ${opts.namespace}`,
          );
          return buildClient(opts);
        },
        inject: [SERVICE_BUS_OPTIONS],
      },
      ServiceBusService,
      ...(asyncOptions.extraProviders ?? []),
    ];

    return {
      module: ServiceBusModule,
      imports: asyncOptions.imports ?? [],
      providers,
      exports: [ServiceBusService],
    };
  }
}
