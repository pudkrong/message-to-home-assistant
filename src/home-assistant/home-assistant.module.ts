import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './home-assistant.constants';
import { HomeAssistantService } from './home-assistant.service';

/**
 * Configurable module around {@link HomeAssistantService}.
 *
 * Extends the `ConfigurableModuleClass` produced by
 * `ConfigurableModuleBuilder`, which supplies the standard
 * `forRoot(options)` / `forRootAsync({ useFactory })` entry points
 * and exposes the options object to the service through
 * `MODULE_OPTIONS_TOKEN`.
 */
@Module({
  providers: [HomeAssistantService],
  exports: [HomeAssistantService],
})
export class HomeAssistantModule extends ConfigurableModuleClass {}
