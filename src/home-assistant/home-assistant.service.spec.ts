import { EventEmitter } from 'node:events';
import mqtt, { MqttClient } from 'mqtt';
import { Test } from '@nestjs/testing';
import { HomeAssistantModule } from './home-assistant.module';
import { HomeAssistantService } from './home-assistant.service';

jest.mock('mqtt', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

interface PublishedMessage {
  topic: string;
  payload: string;
  options: { retain: boolean; qos?: number; properties?: object };
}

const DEVICE_ID = '209727310E81';
const AVAILABILITY_TOPIC = 'ha-mqtt-bridge/availability';

describe('HomeAssistantService device discovery', () => {
  let service: HomeAssistantService;
  let client: EventEmitter & {
    publish: jest.Mock;
    subscribe: jest.Mock;
    end: jest.Mock;
  };
  let published: PublishedMessage[];

  beforeEach(async () => {
    jest.clearAllMocks();
    published = [];
    client = Object.assign(new EventEmitter(), {
      publish: jest.fn(
        (
          topic: string,
          payload: string,
          options: { retain: boolean },
          callback?: (error?: Error) => void,
        ) => {
          published.push({ topic, payload, options });
          callback?.();
        },
      ),
      subscribe: jest.fn((_topic: string, _options: unknown, callback?: (error?: Error) => void) =>
        callback?.(),
      ),
      end: jest.fn((_force: boolean, _options: unknown, callback?: () => void) => callback?.()),
    });
    (mqtt.connect as jest.Mock).mockReturnValue(client as unknown as MqttClient);

    service = new HomeAssistantService({
      mqttUrl: 'mqtt://localhost',
      devices: [
        {
          deviceId: DEVICE_ID,
          sensor: 'AirC 200',
          room: 'Bedroom',
        },
      ],
      discoveryRefreshIntervalSeconds: 0,
    });
    await service.onModuleInit();
    client.emit('connect');
  });

  it('publishes one retained device config containing all registered sensors', async () => {
    await service.publishEntityState(
      DEVICE_ID,
      {
        objectId: 'humidity',
        name: 'Humidity',
        deviceClass: 'humidity',
        unitOfMeasurement: '%',
      },
      45.2,
      '2026-10-14T12:00:00Z',
    );
    await service.publishEntityState(
      DEVICE_ID,
      {
        objectId: 'temperature',
        name: 'Temperature',
        deviceClass: 'temperature',
        unitOfMeasurement: '°C',
      },
      22.1,
    );

    const configMessages = published.filter(
      ({ topic }) => topic === `homeassistant/device/${DEVICE_ID}/config`,
    );
    expect(configMessages).toHaveLength(2);
    expect(configMessages[1]).toMatchObject({ options: { retain: true } });
    expect(JSON.parse(configMessages[1].payload)).toEqual({
      dev: {
        ids: DEVICE_ID,
        name: 'AirC 200',
        suggested_area: 'Bedroom',
      },
      o: { name: 'ha-mqtt-bridge', sw: expect.any(String) },
      cmps: {
        humidity: {
          p: 'sensor',
          unique_id: `${DEVICE_ID}_humidity`,
          name: 'Humidity',
          device_class: 'humidity',
          unit_of_measurement: '%',
          state_topic: `${DEVICE_ID}/humidity/state`,
          value_template: '{{ value_json.value }}',
          availability_topic: AVAILABILITY_TOPIC,
          payload_available: 'online',
          payload_not_available: 'offline',
        },
        temperature: {
          p: 'sensor',
          unique_id: `${DEVICE_ID}_temperature`,
          name: 'Temperature',
          device_class: 'temperature',
          unit_of_measurement: '°C',
          state_topic: `${DEVICE_ID}/temperature/state`,
          value_template: '{{ value_json.value }}',
          availability_topic: AVAILABILITY_TOPIC,
          payload_available: 'online',
          payload_not_available: 'offline',
        },
      },
    });

    expect(published.find(({ topic }) => topic === `${DEVICE_ID}/humidity/state`)).toMatchObject({
      topic: `${DEVICE_ID}/humidity/state`,
      payload: JSON.stringify({ value: 45.2, timestamp: '2026-10-14T12:00:00Z' }),
      options: { retain: true },
    });
    expect(published.find(({ topic }) => topic === `${DEVICE_ID}/temperature/state`)).toMatchObject(
      {
        topic: `${DEVICE_ID}/temperature/state`,
        payload: JSON.stringify({ value: 22.1 }),
        options: { retain: true },
      },
    );
  });

  it('publishes the complete known set in one device config', async () => {
    await service.registerEntities([
      { objectId: 'humidity', name: 'Humidity', deviceClass: 'humidity' },
      { objectId: 'temperature', name: 'Temperature', deviceClass: 'temperature' },
    ]);

    const configs = published.filter(
      ({ topic }) => topic === `homeassistant/device/${DEVICE_ID}/config`,
    );
    expect(configs).toHaveLength(1);
    expect(Object.keys(JSON.parse(configs[0].payload).cmps)).toEqual([
      'humidity',
      'temperature',
    ]);
  });

  it('does not republish discovery for state-only updates', async () => {
    const humidity = {
      objectId: 'humidity',
      name: 'Humidity',
      deviceClass: 'humidity',
      unitOfMeasurement: '%',
    };
    await service.publishEntityState(DEVICE_ID, humidity, 45.2);
    await service.publishEntityState(DEVICE_ID, humidity, 46.1);

    expect(
      published.filter(({ topic }) => topic === `homeassistant/device/${DEVICE_ID}/config`),
    ).toHaveLength(1);
  });

  it('republishes the complete device config when Home Assistant comes online', async () => {
    await service.publishEntityState(
      DEVICE_ID,
      { objectId: 'humidity', name: 'Humidity' },
      45.2,
    );
    await service.publishEntityState(
      DEVICE_ID,
      { objectId: 'temperature', name: 'Temperature' },
      22.1,
    );
    const configTopic = `homeassistant/device/${DEVICE_ID}/config`;
    const before = published.filter(({ topic }) => topic === configTopic);

    client.emit('message', 'homeassistant/status', Buffer.from('online'));

    const after = published.filter(({ topic }) => topic === configTopic);
    expect(after).toHaveLength(before.length + 1);
    expect(JSON.parse(after.at(-1)!.payload).cmps).toHaveProperty('humidity');
    expect(JSON.parse(after.at(-1)!.payload).cmps).toHaveProperty('temperature');
  });

  it('uses the device availability topic for the last will and online status', () => {
    const options = (mqtt.connect as jest.Mock).mock.calls[0][1];
    expect(options.will).toMatchObject({
      topic: AVAILABILITY_TOPIC,
      payload: 'offline',
      retain: true,
    });
    expect(published.find(({ topic }) => topic === AVAILABILITY_TOPIC)).toMatchObject({
      topic: AVAILABILITY_TOPIC,
      payload: 'online',
      options: { retain: true },
    });
  });

  it('publishes separate discovery and state topics for each configured device', async () => {
    const secondDeviceId = 'DEVICE-2';
    const secondClient = Object.assign(new EventEmitter(), {
      publish: jest.fn(
        (
          topic: string,
          payload: string,
          options: { retain: boolean },
          callback?: (error?: Error) => void,
        ) => {
          published.push({ topic, payload, options });
          callback?.();
        },
      ),
      subscribe: jest.fn(
        (_topic: string, _options: unknown, callback?: (error?: Error) => void) =>
          callback?.(),
      ),
      end: jest.fn((_force: boolean, _options: unknown, callback?: () => void) =>
        callback?.(),
      ),
    });
    (mqtt.connect as jest.Mock).mockReturnValueOnce(
      secondClient as unknown as MqttClient,
    );
    const secondService = new HomeAssistantService({
      mqttUrl: 'mqtt://localhost',
      devices: [
        {
          deviceId: DEVICE_ID,
          sensor: 'AirC 200',
          room: 'Bedroom',
        },
        {
          deviceId: secondDeviceId,
          sensor: 'AirC 300',
          room: 'Office',
        },
      ],
      discoveryRefreshIntervalSeconds: 0,
    });

    await secondService.onModuleInit();
    secondClient.emit('connect');
    await secondService.registerEntities([
      { objectId: 'humidity', name: 'Humidity' },
    ]);
    await secondService.publishEntityState(
      secondDeviceId,
      { objectId: 'humidity', name: 'Humidity' },
      52,
    );

    const secondConfig = published.find(
      ({ topic }) => topic === `homeassistant/device/${secondDeviceId}/config`,
    );
    expect(secondConfig).toBeDefined();
    expect(JSON.parse(secondConfig!.payload).dev).toEqual({
      ids: secondDeviceId,
      name: 'AirC 300',
      suggested_area: 'Office',
    });
    expect(published).toContainEqual(
      expect.objectContaining({
        topic: `${secondDeviceId}/humidity/state`,
        payload: JSON.stringify({ value: 52 }),
      }),
    );
  });

  it('loads the device name and room from unit-factories.json in the module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        HomeAssistantModule.forRoot({
          mqttUrl: 'mqtt://localhost',
          unitFactoriesFilePath: 'config/unit-factories.json',
          discoveryRefreshIntervalSeconds: 0,
        }),
      ],
    }).compile();

    await moduleRef.init();
    client.emit('connect');
    await moduleRef.get(HomeAssistantService).registerEntities([
      { objectId: 'humidity', name: 'Humidity' },
    ]);

    const config = published.find(
      ({ topic }) => topic === `homeassistant/device/${DEVICE_ID}/config`,
    );
    expect(JSON.parse(config!.payload).dev).toEqual({
      ids: DEVICE_ID,
      name: 'AirC 200',
      suggested_area: 'Bedroom',
    });
    await moduleRef.close();
  });
});
