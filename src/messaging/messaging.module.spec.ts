import { MessagingModule } from './messaging.module';
import { AzureServiceBusAdapter } from './azure-service-bus.adapter';
import { KubeMqEventsService } from './kubemq-events.adapter';
import { MESSAGE_TRANSPORT } from './messaging.constants';

describe('MessagingModule', () => {
  describe('forRoot', () => {
    it('routes azure provider through AzureServiceBusAdapter', () => {
      const dm = MessagingModule.forRoot({
        provider: 'azure',
        azure: { queue: 'q' },
      });
      const provided = dm.providers?.map((p) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).provide ?? (p as any),
      );
      expect(provided).toContain(AzureServiceBusAdapter);
      expect(provided).toContain(MESSAGE_TRANSPORT);
      expect(provided).not.toContain(KubeMqEventsService);
    });

    it('routes kubemq provider through KubeMqEventsService', () => {
      const dm = MessagingModule.forRoot({
        provider: 'kubemq',
        kubemq: { address: 'localhost:50000', channel: 'events' },
      });
      const provided = dm.providers?.map((p) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).provide ?? (p as any),
      );
      expect(provided).toContain(KubeMqEventsService);
      expect(provided).toContain(MESSAGE_TRANSPORT);
      expect(provided).not.toContain(AzureServiceBusAdapter);
      expect(dm.exports).toContain(MESSAGE_TRANSPORT);
    });

    it('rejects when the provider has no matching options', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        MessagingModule.forRoot({ provider: 'azure' } as any),
      ).toThrow(/requires `azure` options/);
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        MessagingModule.forRoot({ provider: 'kubemq' } as any),
      ).toThrow(/requires `kubemq` options/);
    });

    it('rejects an unknown provider', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const provided = dm.providers?.map((p) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).provide ?? (p as any),
      );
      // LazyModuleLoader means neither adapter is registered at
      // boot - only the facade is. The active adapter subtree is
      // loaded on first use, and the unselected branch never
      // appears in the DI graph at all.
      expect(provided).not.toContain(AzureServiceBusAdapter);
      expect(provided).not.toContain(KubeMqEventsService);
      expect(provided).toContain(MESSAGE_TRANSPORT);
      expect(dm.exports).toContain(MESSAGE_TRANSPORT);
    });
  });
});
