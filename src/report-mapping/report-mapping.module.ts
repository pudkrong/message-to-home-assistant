import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ReportMappingService } from './report-mapping.service';
import { REPORT_MAPPING_OPTIONS } from './report-mapping.constants';
import {
  ReportMappingAsyncOptions,
  ReportMappingOptions,
} from './report-mapping.types';

@Module({})
export class ReportMappingModule {
  static forRoot(options: ReportMappingOptions): DynamicModule {
    return {
      module: ReportMappingModule,
      providers: [
        { provide: REPORT_MAPPING_OPTIONS, useValue: options },
        ReportMappingService,
      ],
      exports: [ReportMappingService],
    };
  }

  static forRootAsync(asyncOptions: ReportMappingAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: REPORT_MAPPING_OPTIONS,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      },
      ReportMappingService,
      ...(asyncOptions.extraProviders ?? []),
    ];
    return {
      module: ReportMappingModule,
      imports: asyncOptions.imports ?? [],
      providers,
      exports: [ReportMappingService],
    };
  }
}
