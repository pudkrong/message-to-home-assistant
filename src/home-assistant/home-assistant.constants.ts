import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { HomeAssistantOptions } from './home-assistant.types';

/**
 * Generates the configurable-module plumbing for this feature:
 * `ConfigurableModuleClass` supplies the `forRoot` / `forRootAsync`
 * static entry points, and `MODULE_OPTIONS_TOKEN` holds the module
 * options. Device metadata is resolved from JSON before service creation.
 */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<HomeAssistantOptions>({
    moduleName: 'HomeAssistant',
  })
    .setClassMethodName('forRoot')
    .build();

export const RESOLVED_OPTIONS_TOKEN = Symbol('HOME_ASSISTANT_RESOLVED_OPTIONS');
