import { DynamicModule, Module } from '@nestjs/common';
import { BridgeService } from './bridge.service';
import { BridgeAsyncOptions, BridgeOptions } from './bridge.types';
import { MessagingModule } from '../messaging/messaging.module';
import { ReportMappingModule } from '../report-mapping/report-mapping.module';
import { UnitFactoryFilterModule } from '../unit-factory-filter/unit-factory-filter.module';
import { HomeAssistantModule } from '../home-assistant/home-assistant.module';

/**
 * Composition module that wires the four infra modules together.
 *
 * Each child module is self-contained and can be used on its own;
 * `BridgeModule` is just a convenience that declares the right
 * dependency set and forwards per-module options. No `@Global()` —
 * every module declares the dependencies it actually uses.
 *
 * Implementation note: rather than rely on a shared DI token that
 * would force a parent/child DI contract across module boundaries,
 * each child `forRootAsync` derives its slice by invoking the
 * parent `useFactory` itself and projecting its field. This keeps
 * every level self-contained at the cost of the factory running
 * once per child — for env-based configs (the common case) this is
 * idempotent; for stateful factories, pass resolved `BridgeOptions`
 * to {@link BridgeModule.forRoot} directly.
 */
@Module({})
export class BridgeModule {
  /** Register with a fully-resolved options object. */
  static forRoot(options: BridgeOptions): DynamicModule {
    return {
      module: BridgeModule,
      imports: [
        MessagingModule.forRoot(options.messaging),
        ReportMappingModule.forRoot(options.reportMapping),
        UnitFactoryFilterModule.forRoot(options.unitFactoryFilter),
        HomeAssistantModule.forRoot(options.homeAssistant),
      ],
      providers: [BridgeService],
      exports: [BridgeService],
    };
  }

  /**
   * Register from a factory that returns the wiring options. Each
   * child module receives its slice via a downstream `useFactory`
   * that invokes the parent factory and projects its field.
   */
  static forRootAsync(asyncOptions: BridgeAsyncOptions): DynamicModule {
    const useFactory = asyncOptions.useFactory;
    const inject = asyncOptions.inject ?? [];
    const imports = asyncOptions.imports ?? [];

    const project = <K extends keyof BridgeOptions>(
      key: K,
    ): ((opts: BridgeOptions) => BridgeOptions[K]) => (opts) => opts[key];

    return {
      module: BridgeModule,
      imports: [
        ...imports,
        MessagingModule.forRootAsync({
          imports,
          useFactory: async (...args: Parameters<typeof useFactory>) => {
            const opts = await useFactory(...args);
            return project('messaging')(opts);
          },
          inject,
        }),
        ReportMappingModule.forRootAsync({
          imports,
          useFactory: async (...args: Parameters<typeof useFactory>) => {
            const opts = await useFactory(...args);
            return project('reportMapping')(opts);
          },
          inject,
        }),
        UnitFactoryFilterModule.forRootAsync({
          imports,
          useFactory: async (...args: Parameters<typeof useFactory>) => {
            const opts = await useFactory(...args);
            return project('unitFactoryFilter')(opts);
          },
          inject,
        }),
        HomeAssistantModule.forRootAsync({
          imports,
          useFactory: async (...args: Parameters<typeof useFactory>) => {
            const opts = await useFactory(...args);
            return project('homeAssistant')(opts);
          },
          inject,
        }),
      ],
      providers: [BridgeService],
      exports: [BridgeService],
    };
  }
}
