import { DynamicModule, Module, Provider } from '@nestjs/common';
import { UnitFactoryFilterService } from './unit-factory-filter.service';
import { UNIT_FACTORY_FILTER_OPTIONS } from './unit-factory-filter.constants';
import {
  UnitFactoryFilterAsyncOptions,
  UnitFactoryFilterOptions,
} from './unit-factory-filter.types';

@Module({})
export class UnitFactoryFilterModule {
  static forRoot(options: UnitFactoryFilterOptions): DynamicModule {
    return {
      module: UnitFactoryFilterModule,
      providers: [
        { provide: UNIT_FACTORY_FILTER_OPTIONS, useValue: options },
        UnitFactoryFilterService,
      ],
      exports: [UnitFactoryFilterService],
    };
  }

  static forRootAsync(asyncOptions: UnitFactoryFilterAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: UNIT_FACTORY_FILTER_OPTIONS,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      },
      UnitFactoryFilterService,
      ...(asyncOptions.extraProviders ?? []),
    ];
    return {
      module: UnitFactoryFilterModule,
      imports: asyncOptions.imports ?? [],
      providers,
      exports: [UnitFactoryFilterService],
    };
  }
}
