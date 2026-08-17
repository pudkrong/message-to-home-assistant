import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './report-mapping.constants';
import { ReportMappingService } from './report-mapping.service';

/**
 * Configurable module around {@link ReportMappingService}.
 *
 * Extends the `ConfigurableModuleClass` produced by
 * `ConfigurableModuleBuilder`, which supplies the standard
 * `forRoot(options)` / `forRootAsync({ useFactory })` entry points
 * and exposes the options object to the service through
 * `MODULE_OPTIONS_TOKEN`.
 */
@Module({
  providers: [ReportMappingService],
  exports: [ReportMappingService],
})
export class ReportMappingModule extends ConfigurableModuleClass {}
