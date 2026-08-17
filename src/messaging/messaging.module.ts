import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { LazyModuleLoader } from '@nestjs/core';
import { AzureServiceBusModule } from './azure-service-bus.module';
import { AzureServiceBusService } from './azure-service-bus.service';
import { KubeMqEventsModule } from './kubemq-events.module';
import { KubeMqEventsService } from './kubemq-events.service';
import { MESSAGE_TRANSPORT } from './messaging.constants';
import { MessageHandler, MessageTransport } from './messaging.transport';
import {
  MessagingAsyncOptions,
  MessagingOptions,
  MessagingProvider,
} from './messaging.types';

/**
 * Throw early if the {@link MessagingOptions} for the chosen
 * provider are missing. Better to fail at module load than to
 * silently end up with no messages flowing.
 */
function assertProviderOptions(opts: MessagingOptions): void {
  if (opts.provider === 'azure' && !opts.azure) {
    throw new Error('[Messaging] provider="azure" requires `azure` options');
  }
  if (opts.provider === 'kubemq' && !opts.kubemq) {
    throw new Error('[Messaging] provider="kubemq" requires `kubemq` options');
  }
}

function logProviderChoice(opts: MessagingOptions): void {
  const logger = new Logger('MessagingModule');
  const detail =
    opts.provider === 'azure'
      ? `queue=${opts.azure?.queue}`
      : `channel=${opts.kubemq?.channel}@${opts.kubemq?.address}`;
  logger.log(`Active transport: ${opts.provider} (${detail})`);
}

/**
 * Internal DI token holding the resolved {@link MessagingOptions}.
 */
const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');

/**
 * Returns the DynamicModule that owns the chosen broker backend.
 *
 * Each provider has its own dedicated dynamic module
 * ({@link AzureServiceBusModule} / {@link KubeMqEventsModule}) that
 * wires up its adapter behind the provider-agnostic
 * {@link MESSAGE_TRANSPORT} token; this function only picks which
 * one based on {@link MessagingOptions.provider}. Used directly by
 * {@link forRootStatic} and indirectly by the {@link forRootAsync}
 * path via {@link LazyModuleLoader}.
 */
function buildActiveAdapterModule(options: MessagingOptions): DynamicModule {
  assertProviderOptions(options);
  switch (options.provider as MessagingProvider) {
    case 'azure':
      return AzureServiceBusModule.forRoot(options.azure!);
    case 'kubemq':
      return KubeMqEventsModule.forRoot(options.kubemq!);
    default: {
      const _exhaustive: never = options.provider as never;
      void _exhaustive;
      throw new Error(
        `[Messaging] unsupported provider: ${options.provider as string}`,
      );
    }
  }
}

function forRootStatic(options: MessagingOptions): DynamicModule {
  assertProviderOptions(options);
  logProviderChoice(options);
  return buildActiveAdapterModule(options);
}

/**
 * Async entry point. The user's factory resolves the
 * {@link MessagingOptions} lazily; a thin facade then defers the
 * actual adapter instantiation to {@link LazyModuleLoader} so the
 * unselected branch never opens a connection at boot.
 */
function forRootAsync(asyncOptions: MessagingAsyncOptions): DynamicModule {
  const MESSAGING_FACADE = Symbol('MESSAGING_FACADE');
  const providers: Provider[] = [
    {
      provide: MESSAGING_OPTIONS,
      useFactory: asyncOptions.useFactory,
      inject: asyncOptions.inject ?? [],
    },
    {
      provide: MESSAGING_FACADE,
      useClass: MessagingTransportFacade,
    },
    {
      provide: MESSAGE_TRANSPORT,
      useExisting: MESSAGING_FACADE,
    },
  ];
  return {
    module: MessagingModule,
    imports: asyncOptions.imports ?? [],
    providers,
    exports: [MESSAGE_TRANSPORT],
  };
}

/**
 * Facade used by {@link MessagingModule.forRootAsync}. Public
 * surface area to consumers is just the {@link MessageTransport}
 * token; under the hood it holds off on selecting an adapter
 * until {@link OnModuleInit}, then loads the right subtree via
 * {@link LazyModuleLoader} and forwards registration calls.
 *
 * Why this exists: Nest eagerly walks every provider in a
 * module's `providers` array at boot. If we registered both
 * adapters here directly, the unselected branch's broker client
 * would be constructed even when we never call any of its
 * methods. {@link LazyModuleLoader} avoids that - we never tell
 * Nest about the unselected branch at all.
 *
 * Lifecycle caveat: `LazyModuleLoader.load()` constructs
 * instances inside the lazy subtree but does NOT fire their
 * `onModuleInit` / `onApplicationShutdown` hooks. We drive
 * those manually below; `app.close()` does the rest because the
 * lazy module is registered in the {@link ModulesContainer}.
 */
@Injectable()
export class MessagingTransportFacade
  implements MessageTransport, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(MessagingTransportFacade.name);
  private resolvedOptions: MessagingOptions | undefined;
  private adapter: MessageTransport | undefined;
  private serviceBusRef: AzureServiceBusService | undefined;
  private kubemqRef: KubeMqEventsService | undefined;

  constructor(
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingOptions,
    private readonly lazyLoader: LazyModuleLoader,
  ) {}

  async onModuleInit(): Promise<void> {
    this.resolvedOptions = this.options;
    logProviderChoice(this.resolvedOptions);
    this.logger.log(
      'Lazily loading active adapter subtree to keep the unused broker dormant',
    );
    const moduleRef = await this.lazyLoader.load(() =>
      buildActiveAdapterModule(this.resolvedOptions!),
    );
    this.adapter = moduleRef.get(MESSAGE_TRANSPORT, { strict: false });

    // Drive the lazy subtree's `onModuleInit` ourselves - the
    // LazyModuleLoader only builds instances.
    switch (this.resolvedOptions.provider) {
      case 'azure': {
        this.serviceBusRef = moduleRef.get(AzureServiceBusService, {
          strict: false,
        });
        await this.serviceBusRef!.onModuleInit();
        break;
      }
      case 'kubemq': {
        this.kubemqRef = moduleRef.get(KubeMqEventsService, {
          strict: false,
        });
        await this.kubemqRef!.onModuleInit();
        break;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Nest's app shutdown walks every provider in every loaded
    // module - including this lazy subtree - so onModuleInit's
    // counterpart on the lazy service fires automatically. No
    // manual close needed.
  }

  registerHandler(handler: MessageHandler): void {
    if (!this.adapter) {
      throw new Error('[Messaging] adapter not loaded yet');
    }
    this.adapter.registerHandler(handler);
  }
}

/**
 * Provider-agnostic messaging wiring.
 *
 * The user must pick exactly one broker backend for their app by
 * setting {@link MessagingOptions.provider} to `'azure'` or
 * `'kubemq'` and supplying the matching options block. The choice
 * is validated at registration time and only the selected
 * provider's dynamic module ({@link AzureServiceBusModule} or
 * {@link KubeMqEventsModule}) is ever wired in - the other broker
 * stays completely out of the DI graph.
 *
 * Adding a new provider is three steps:
 *   1. Add a value to {@link MessagingProvider}.
 *   2. Add an options block to {@link MessagingOptions}.
 *   3. Create a provider module exposing {@link MESSAGE_TRANSPORT}
 *      and return it from {@link buildActiveAdapterModule}.
 */
@Module({})
export class MessagingModule {
  /** Sync entry point - resolve options in the caller. */
  static forRoot(options: MessagingOptions): DynamicModule {
    return forRootStatic(options);
  }

  /** Async entry point - defers the active adapter via {@link LazyModuleLoader}. */
  static forRootAsync(asyncOptions: MessagingAsyncOptions): DynamicModule {
    return forRootAsync(asyncOptions);
  }
}
