import { Test, TestingModule } from '@nestjs/testing';
import { BridgeService } from './bridge.service';
import { MESSAGE_TRANSPORT } from '../messaging/messaging.constants';
import type { MessageTransport } from '../messaging/messaging.transport';
import { ReportMappingService } from '../report-mapping/report-mapping.service';
import { UnitFactoryFilterService } from '../unit-factory-filter/unit-factory-filter.service';
import { HomeAssistantService } from '../home-assistant/home-assistant.service';

interface PublishedEntity {
  deviceId: string;
  objectId: string;
  value: string | number | boolean;
  timestamp?: string;
}

describe('BridgeService', () => {
  let bridge: BridgeService;
  let handlers: Array<(body: unknown) => Promise<void> | void> = [];
  let published: PublishedEntity[] = [];
  let registered: string[] = [];

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
    registered = [];

    const transport: MessageTransport = {
      registerHandler: (h) => handlers.push(h),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeService,
        { provide: MESSAGE_TRANSPORT, useValue: transport },
        {
          provide: ReportMappingService,
          useValue: {
            get: (id: number) => {
              if (id === humidityDescriptor.reportId) return humidityDescriptor;
              if (id === temperatureDescriptor.reportId) return temperatureDescriptor;
              return undefined;
            },
            entries: () => [humidityDescriptor, temperatureDescriptor],
          },
        },
        {
          provide: UnitFactoryFilterService,
          useValue: {
            isAllowed: (num: string) =>
              ['1234-000000-100000', '1234-000000-200000'].includes(num),
            get: (num: string) => {
              const deviceIdByNumber: Record<string, string> = {
                '1234-000000-100000': '209727310E81',
                '1234-000000-200000': 'DEVICE-2',
              };
              const deviceId = deviceIdByNumber[num];
              return deviceId ? { unitFactoryNumber: num, deviceId } : undefined;
            },
          },
        },
        {
          provide: HomeAssistantService,
          useValue: {
            registerEntities: async (entities: Array<{ objectId: string }>) => {
              registered = entities.map(({ objectId }) => objectId);
            },
            publishEntityState: async (
              deviceId: string,
              entity: { objectId: string },
              value: string | number | boolean,
              timestamp?: string,
            ) => {
              published.push({ deviceId, objectId: entity.objectId, value, timestamp });
            },
          },
        },
      ],
    }).compile();

    bridge = moduleRef.get(BridgeService);
    await bridge.onModuleInit();
  });

  it('registers one transport handler on init', () => {
    expect(handlers).toHaveLength(1);
  });

  it('pre-registers every mapped entity for complete device discovery', () => {
    expect(registered).toEqual(['humidity', 'temperature']);
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
      {
        deviceId: '209727310E81',
        objectId: 'humidity',
        value: 70.2,
        timestamp: '2026-08-16T22:07:21.000Z',
      },
      {
        deviceId: '209727310E81',
        objectId: 'temperature',
        value: 25.8,
        timestamp: '2026-08-16T22:07:21.000Z',
      },
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

  it('routes each factory message to its configured device', async () => {
    await handlers[0]({
      unitFactoryNumber: '1234-000000-200000',
      version: 1,
      timestamp: '2026-08-16T22:07:21.000Z',
      data: [{ reportId: 10116, value: 51 }],
    });

    expect(published).toEqual([
      {
        deviceId: 'DEVICE-2',
        objectId: 'humidity',
        value: 51,
        timestamp: '2026-08-16T22:07:21.000Z',
      },
    ]);
  });

  it('ignores messages that do not match the v1 schema', async () => {
    await handlers[0]({ something: 'else' });
    expect(published).toEqual([]);
  });
});
