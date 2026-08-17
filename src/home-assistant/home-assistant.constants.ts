import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { HomeAssistantOptions } from './home-assistant.types';

/**
 * Generates the configurable-module plumbing for this feature:
 * `ConfigurableModuleClass` supplies the `forRoot` / `forRootAsync`
 * static entry points, and `MODULE_OPTIONS_TOKEN` is the injection
 * token through which {@link HomeAssistantOptions} reaches the
 * service.
 */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<HomeAssistantOptions>({
    moduleName: 'HomeAssistant',
  })
    .setClassMethodName('forRoot')
    .build();
