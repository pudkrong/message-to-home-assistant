import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { ReportMappingOptions } from './report-mapping.types';

/**
 * Generates the configurable-module plumbing for this feature:
 * `ConfigurableModuleClass` supplies the `forRoot` / `forRootAsync`
 * static entry points, and `MODULE_OPTIONS_TOKEN` is the injection
 * token through which {@link ReportMappingOptions} reaches the
 * service.
 */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ReportMappingOptions>({
    moduleName: 'ReportMapping',
  })
    .setClassMethodName('forRoot')
    .build();
