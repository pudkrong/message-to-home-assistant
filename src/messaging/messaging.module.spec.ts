import { MessagingModule } from './messaging.module';
import { AzureServiceBusModule } from './azure-service-bus.module';
import { KubeMqEventsModule } from './kubemq-events.module';
import { MODULE_OPTIONS_TOKEN as AZURE_SERVICE_BUS_OPTIONS } from './azure-service-bus.constants';
import { MODULE_OPTIONS_TOKEN as KUBEMQ_EVENTS_OPTIONS } from './kubemq-events.constants';
import { AzureServiceBusService } from './azure-service-bus.service';
import { KubeMqEventsService } from './kubemq-events.service';
import { MESSAGE_TRANSPORT } from './messaging.constants';

describe('MessagingModule', () => {
  describe('forRoot', () => {
    it('routes azure provider through its own AzureServiceBusModule', () => {
      const dm = MessagingModule.forRoot({
        provider: 'azure',
        azure: { queue: 'q' },
      });

      // The selection resolves to the dedicated Azure Service Bus
      // dynamic module - the KubeMQ branch is never wired in. The
      // service and MESSAGE_TRANSPORT alias live in the module's
      // @Module metadata; ConfigurableModuleClass only adds the
      // options provider here.
      expect(dm.module).toBe(AzureServiceBusModule);
      expect(dm.providers).toContainEqual({
        provide: AZURE_SERVICE_BUS_OPTIONS,
        useValue: { queue: 'q' },
      });
    });

    it('routes kubemq provider through its own KubeMqEventsModule', () => {
      const dm = MessagingModule.forRoot({
        provider: 'kubemq',
        kubemq: { address: 'localhost:50000', channel: 'events' },
      });

      expect(dm.module).toBe(KubeMqEventsModule);
      expect(dm.providers).toContainEqual({
        provide: KUBEMQ_EVENTS_OPTIONS,
        useValue: { address: 'localhost:50000', channel: 'events' },
      });
    });

    it('rejects when the provider has no matching options', () => {
      expect(() =>
        MessagingModule.forRoot({ provider: 'azure' } as any),
      ).toThrow(/requires `azure` options/);
      expect(() =>
        MessagingModule.forRoot({ provider: 'kubemq' } as any),
      ).toThrow(/requires `kubemq` options/);
    });

    it('rejects an unknown provider', () => {
      expect(() =>
        MessagingModule.forRoot({ provider: 'kafka' } as any),
      ).toThrow(/unsupported provider/);
    });
  });

  describe('forRootAsync', () => {
    it('keeps the unselected branch out of the provider list', () => {
      const dm = MessagingModule.forRootAsync({
        useFactory: () => ({
          provider: 'azure',
          azure: { queue: 'q' },
        }),
      });
      const provided = dm.providers?.map(
        (p) => (p as any).provide ?? (p as any),
      );
      // LazyModuleLoader means neither adapter is registered at
      // boot - only the facade is. The active adapter subtree is
      // loaded on first use, and the unselected branch never
      // appears in the DI graph at all.
      expect(provided).not.toContain(AzureServiceBusService);
      expect(provided).not.toContain(KubeMqEventsService);
      expect(provided).toContain(MESSAGE_TRANSPORT);
      expect(dm.exports).toContain(MESSAGE_TRANSPORT);
    });
  });
});
