import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { AzureServiceBusOptions } from './azure-service-bus.service';

/**
 * Generates the configurable-module plumbing for the Azure Service
 * Bus adapter: `ConfigurableModuleClass` supplies the `forRoot` /
 * `forRootAsync` static entry points, and `MODULE_OPTIONS_TOKEN` is
 * the injection token through which {@link AzureServiceBusOptions}
 * reaches {@link AzureServiceBusService}.
 */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<AzureServiceBusOptions>({
    moduleName: 'AzureServiceBus',
  })
    .setClassMethodName('forRoot')
    .build();
