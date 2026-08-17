import { DynamicModule, Module, Provider } from '@nestjs/common';
import { HomeAssistantService } from './home-assistant.service';
import { HOME_ASSISTANT_OPTIONS } from './home-assistant.constants';
import {
  HomeAssistantAsyncOptions,
  HomeAssistantOptions,
} from './home-assistant.types';

@Module({})
export class HomeAssistantModule {
  static forRoot(options: HomeAssistantOptions): DynamicModule {
    return {
      module: HomeAssistantModule,
      providers: [
        { provide: HOME_ASSISTANT_OPTIONS, useValue: options },
        HomeAssistantService,
      ],
      exports: [HomeAssistantService],
    };
  }

  static forRootAsync(asyncOptions: HomeAssistantAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: HOME_ASSISTANT_OPTIONS,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      },
      HomeAssistantService,
      ...(asyncOptions.extraProviders ?? []),
    ];
    return {
      module: HomeAssistantModule,
      imports: asyncOptions.imports ?? [],
      providers,
      exports: [HomeAssistantService],
    };
  }
}
