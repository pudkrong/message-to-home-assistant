import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { UnitFactoryFilterOptions } from './unit-factory-filter.types';

/**
 * Generates the configurable-module plumbing for this feature:
 * `ConfigurableModuleClass` supplies the `forRoot` / `forRootAsync`
 * static entry points, and `MODULE_OPTIONS_TOKEN` is the injection
 * token through which {@link UnitFactoryFilterOptions} reaches the
 * service.
 */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<UnitFactoryFilterOptions>({
    moduleName: 'UnitFactoryFilter',
  })
    .setClassMethodName('forRoot')
    .build();
