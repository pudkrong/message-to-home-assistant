import { Test, TestingModule } from '@nestjs/testing';
import { BridgeService } from './bridge.service';
import { ServiceBusService } from '../service-bus/service-bus.service';
import { ReportMappingService } from '../report-mapping/report-mapping.service';
import { UnitFactoryFilterService } from '../unit-factory-filter/unit-factory-filter.service';
import { HomeAssistantService } from '../home-assistant/home-assistant.service';
import { REPORT_MAPPING_OPTIONS } from '../report-mapping/report-mapping.constants';
import { UNIT_FACTORY_FILTER_OPTIONS } from '../unit-factory-filter/unit-factory-filter.constants';

interface PublishedEntity {
  objectId: string;
  value: string | number | boolean;
  timestamp?: string;
}

describe('BridgeService', () => {
  let bridge: BridgeService;
  let handlers: Array<(body: unknown) => Promise<void> | void> = [];
  let published: PublishedEntity[] = [];

  const humidityDescriptor = {
    reportId: 10116,
    description: 'humidity',
    name: 'Humidity',
    deviceClass: 'humidity',
    unitOfMeasurement: '%',
  };
  const temperatureDescriptor = {
    reportId: 10122,
    description: 'temperature',
    name: 'Temperature',
    deviceClass: 'temperature',
    unitOfMeasurement: '°C',
  };

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
              if (id === humidityDescriptor.reportId) return humidityDescriptor;
              if (id === temperatureDescriptor.reportId) return temperatureDescriptor;
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
            publishEntityState: async (
              entity: { objectId: string },
              value: string | number | boolean,
              timestamp?: string,
            ) => {
              published.push({ objectId: entity.objectId, value, timestamp });
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

  it('publishes every mapped report for an allowed factory and forwards the timestamp', async () => {
    await handlers[0]({
      unitFactoryNumber: '1234-000000-100000',
      version: 1,
      timestamp: '2026-08-16T22:07:21.000Z',
      data: [
        { reportId: 10102, value: 3 }, // not in mapping
        { reportId: 10116, value: 70.2 }, // humidity
        { reportId: 10122, value: 25.8 }, // temperature
        { reportId: 99999, value: 1 }, // unknown
      ],
    });
    expect(published).toEqual([
      { objectId: 'humidity', value: 70.2, timestamp: '2026-08-16T22:07:21.000Z' },
      { objectId: 'temperature', value: 25.8, timestamp: '2026-08-16T22:07:21.000Z' },
    ]);
  });

  it('skips messages from non-allowed factories', async () => {
    await handlers[0]({
      unitFactoryNumber: 'NOT-ALLOWED',
      version: 1,
      timestamp: '2026-08-16T13:51:55.000Z',
      data: [{ reportId: 10116, value: 50 }],
    });
    expect(published).toEqual([]);
  });

  it('ignores messages that do not match the v1 schema', async () => {
    await handlers[0]({ something: 'else' });
    expect(published).toEqual([]);
  });
});
