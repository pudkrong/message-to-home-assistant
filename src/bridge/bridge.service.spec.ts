import { Test, TestingModule } from '@nestjs/testing';
import { BridgeService } from './bridge.service';
import { ServiceBusService } from '../service-bus/service-bus.service';
import { ReportMappingService } from '../report-mapping/report-mapping.service';
import { UnitFactoryFilterService } from '../unit-factory-filter/unit-factory-filter.service';
import { HomeAssistantService } from '../home-assistant/home-assistant.service';
import { REPORT_MAPPING_OPTIONS } from '../report-mapping/report-mapping.constants';
import { UNIT_FACTORY_FILTER_OPTIONS } from '../unit-factory-filter/unit-factory-filter.constants';

describe('BridgeService', () => {
  let bridge: BridgeService;
  let handlers: Array<(body: unknown) => Promise<void> | void> = [];
  let published: Array<{ objectId: string; value: string | number | boolean }> = [];

  beforeEach(async () => {
    handlers = [];
    published = [];

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeService,
        {
          provide: ServiceBusService,
          useValue: {
            onMessage: (h: (b: unknown) => Promise<void> | void) => handlers.push(h),
          },
        },
        {
          provide: ReportMappingService,
          useValue: {
            get: (id: number) => {
              if (id === 10168) {
                return {
                  reportId: 10168,
                  description: 'humidity',
                  name: 'Humidity',
                  deviceClass: 'humidity',
                  unitOfMeasurement: '%',
                };
              }
              return undefined;
            },
          },
        },
        {
          provide: UnitFactoryFilterService,
          useValue: {
            isAllowed: (num: string) => num === '1234-000000-100000',
          },
        },
        {
          provide: HomeAssistantService,
          useValue: {
            publishEntityState: async (entity: any, value: string | number | boolean) => {
              published.push({ objectId: entity.objectId, value });
            },
          },
        },
        // provide options tokens so the real ReportMapping/UnitFactoryFilter
        // modules would load if they were wired in - keeping them out for now
        { provide: REPORT_MAPPING_OPTIONS, useValue: { source: { type: 'json', filePath: '' } } },
        { provide: UNIT_FACTORY_FILTER_OPTIONS, useValue: { source: { type: 'json', filePath: '' } } },
      ],
    }).compile();

    bridge = moduleRef.get(BridgeService);
    bridge.onModuleInit();
  });

  it('registers one service-bus handler on init', () => {
    expect(handlers).toHaveLength(1);
  });

  it('publishes only mapped reports for an allowed factory', async () => {
    await handlers[0]({
      unitFactoryNumber: '1234-000000-100000',
      version: 1,
      timestamp: '2026-08-16T13:51:55.000Z',
      data: [
        { reportId: 10102, value: 3 }, // not in mapping
        { reportId: 10168, value: 35 }, // humidity -> should publish
        { reportId: 99999, value: 1 }, // unknown
      ],
    });
    expect(published).toEqual([{ objectId: 'humidity', value: 35 }]);
  });

  it('skips messages from non-allowed factories', async () => {
    await handlers[0]({
      unitFactoryNumber: 'NOT-ALLOWED',
      version: 1,
      timestamp: '2026-08-16T13:51:55.000Z',
      data: [{ reportId: 10168, value: 50 }],
    });
    expect(published).toEqual([]);
  });

  it('ignores messages that do not match the v1 schema', async () => {
    await handlers[0]({ something: 'else' });
    expect(published).toEqual([]);
  });
});
