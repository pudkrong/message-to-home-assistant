import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './unit-factory-filter.constants';
import { UnitFactoryFilterService } from './unit-factory-filter.service';

/**
 * Configurable module around {@link UnitFactoryFilterService}.
 *
 * Extends the `ConfigurableModuleClass` produced by
 * `ConfigurableModuleBuilder`, which supplies the standard
 * `forRoot(options)` / `forRootAsync({ useFactory })` entry points
 * and exposes the options object to the service through
 * `MODULE_OPTIONS_TOKEN`.
 */
@Module({
  providers: [UnitFactoryFilterService],
  exports: [UnitFactoryFilterService],
})
export class UnitFactoryFilterModule extends ConfigurableModuleClass {}
