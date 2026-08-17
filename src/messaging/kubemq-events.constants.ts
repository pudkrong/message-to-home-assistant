import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { KubeMqEventsOptions } from './kubemq-events.service';

/**
 * Generates the configurable-module plumbing for the KubeMQ Events
 * adapter: `ConfigurableModuleClass` supplies the `forRoot` /
 * `forRootAsync` static entry points, and `MODULE_OPTIONS_TOKEN` is
 * the injection token through which {@link KubeMqEventsOptions}
 * reaches {@link KubeMqEventsService}.
 */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<KubeMqEventsOptions>({
    moduleName: 'KubeMqEvents',
  })
    .setClassMethodName('forRoot')
    .build();
