import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import mqtt, { MqttClient } from 'mqtt';
import packageJson from '../../package.json';
import { RESOLVED_OPTIONS_TOKEN } from './home-assistant.constants';
import type {
  HomeAssistantEntityConfig,
  ResolvedHomeAssistantOptions,
} from './home-assistant.types';
import { parseMqttUrl, slugify } from './util';
import { randomUUID } from 'node:crypto';

interface Deferred {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * MQTT state payload published to each entity's state topic.
 *
 * Always wraps the numeric value in JSON so HA can read both the
 * value (via `value_template`) and the optional `timestamp`
 * attribute. The `timestamp` lets consumers see when the
 * upstream measurement was actually taken, not just when HA
 * received it.
 */
interface SensorStatePayload {
  value: string | number | boolean;
  timestamp?: string;
}

/**
 * Explicit MQTT v5 message-expiry interval (seconds) applied to
 * retained discovery/availability messages. Managed brokers such as
 * HiveMQ Cloud expire retained messages on their own schedule
 * (~72h on the free tier), which silently deletes discovery configs
 * and makes devices disappear from Home Assistant after a restart.
 * Setting an explicit, shorter interval plus the periodic refresh
 * keeps retention deterministically alive.
 */
const DISCOVERY_MESSAGE_EXPIRY_SECONDS = 86_400;
const ORIGIN_NAME = 'ha-mqtt-bridge';
// One MQTT connection can have only one Last Will topic, so all devices share availability.
const AVAILABILITY_TOPIC = `${ORIGIN_NAME}/availability`;

/**
 * Generic MQTT bridge to Home Assistant. The module only owns
 * connection lifecycle, availability, discovery publishing and
 * per-entity state publish - it does not know anything about
 * Service Bus or report mapping.
 */
@Injectable()
export class HomeAssistantService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HomeAssistantService.name);
  private client: MqttClient | undefined;
  private parsed: ReturnType<typeof parseMqttUrl> | undefined;
  private readonly registered = new Map<string, Map<string, HomeAssistantEntityConfig>>();
  private readonly deferredQueue: Deferred[] = [];
  private online = false;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private readonly discoveryDirty = new Set<string>();

  constructor(
    @Inject(RESOLVED_OPTIONS_TOKEN)
    private readonly options: ResolvedHomeAssistantOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.mqttUrl) {
      throw new Error('[HomeAssistant] MQTT_URL is required');
    }
    if (this.options.devices.length === 0) {
      throw new Error('[HomeAssistant] at least one device is required');
    }

    this.parsed = parseMqttUrl(this.options.mqttUrl);

    const clientId = this.options.clientId ?? `nestjs-ha-bridge-${randomUUID()}`;
    const connectUrl = `${this.parsed.protocol}://${this.parsed.host}:${this.parsed.port}`;

    const statusTopic = `${this.discovery()}/status`;

    this.client = mqtt.connect(connectUrl, {
      clientId,
      username: this.parsed.username,
      password: this.parsed.password,
      reconnectPeriod: 5000,
      clean: true,
      // MQTT v5 so retained messages can carry an explicit
      // message-expiry interval (see DISCOVERY_MESSAGE_EXPIRY_SECONDS).
      protocolVersion: 5,
      // Last Will: if this app dies ungracefully the broker publishes a
      // retained "offline" so HA marks the device unavailable instead of
      // showing stale data forever.
      will: {
        topic: AVAILABILITY_TOPIC,
        payload: 'offline',
        qos: 0,
        retain: true,
      },
    });

    this.client.on('connect', () => {
      this.online = true;
      this.logger.log(
        `Connected to MQTT broker ${this.parsed?.host}:${this.parsed?.port}` +
          ` as ${this.parsed?.username ?? '<anonymous>'}`,
      );
      // The session is clean - re-subscribe on every (re)connect so we
      // keep receiving HA's birth message.
      this.client?.subscribe(statusTopic, { qos: 0 }, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to ${statusTopic}: ${err.message}`);
        }
      });
      // Push retained "online" so HA immediately marks us available.
      this.publishAvailability(true).catch(() => undefined);
      // Re-announce all discovery configs: covers brokers that lost or
      // expired the retained configs while we were disconnected.
      this.refreshAllDiscovery();
      while (this.deferredQueue.length > 0) {
        this.deferredQueue.shift()?.resolve();
      }
    });

    // HA publishes "online" to `<prefix>/status` whenever its MQTT
    // integration starts. Re-announce immediately so entities are
    // recreated without waiting for the periodic refresh timer.
    this.client.on('message', (topic, payload) => {
      if (topic !== statusTopic || payload.toString() !== 'online') return;
      this.logger.log('Home Assistant came online - re-announcing discovery configs');
      this.publishAvailability(true).catch(() => undefined);
      this.refreshAllDiscovery();
    });

    this.client.on('reconnect', () => this.logger.warn('MQTT reconnecting...'));
    this.client.on('error', (err) => this.logger.error(`MQTT error: ${err.message}`));
    this.client.on('close', () => {
      this.online = false;
      this.logger.warn('MQTT connection closed');
    });

    const interval = (this.options.discoveryRefreshIntervalSeconds ?? 3600) * 1_000;
    if (interval > 0) {
      this.logger.log(
        `Discovery refresh every ${this.options.discoveryRefreshIntervalSeconds ?? 3600}s`,
      );
      this.refreshTimer = setInterval(() => this.refreshAllDiscovery(), interval);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
      if (this.client?.connected) {
        await this.publishAvailability(false);
      }
    } catch (err) {
      this.logger.warn(`Failed to publish offline availability: ${(err as Error).message}`);
    }
    await new Promise<void>((resolve) => this.client?.end(false, {}, () => resolve()));
  }

  /**
   * Register an entity and publish the complete device config when its
   * definition changes. Repeated state updates do not republish config.
   *
   * All sensors use the JSON state shape
   * (`{ value, timestamp? }`) and a `value_template` so the timestamp
   * from the upstream message lands in HA as an attribute instead
   * of being silently dropped.
   */
  async registerEntity(entity: HomeAssistantEntityConfig): Promise<void> {
    await this.registerEntities([entity]);
  }

  /** Register a complete known set of entities with one discovery update. */
  async registerEntities(entities: HomeAssistantEntityConfig[]): Promise<void> {
    for (const device of this.options.devices) {
      const deviceEntities = this.registered.get(device.deviceId) ?? new Map();
      let changed = false;
      for (const entity of entities) {
        if (!entity.objectId) {
          throw new Error('[HomeAssistant] entity.objectId is required');
        }
        const componentKey = slugify(entity.objectId);
        if (!componentKey) {
          throw new Error('[HomeAssistant] entity.objectId must contain letters or numbers');
        }

        const existing = deviceEntities.get(componentKey);
        if (existing && this.sameEntityConfig(existing, entity)) continue;

        deviceEntities.set(componentKey, entity);
        changed = true;
        this.logger.log(`Registered entity ${device.deviceId}_${componentKey} (${entity.name})`);
      }
      this.registered.set(device.deviceId, deviceEntities);
      if (changed) this.discoveryDirty.add(device.deviceId);
    }

    if (this.online) {
      for (const device of this.options.devices) {
        if (this.discoveryDirty.has(device.deviceId)) {
          await this.publishDeviceDiscovery(device.deviceId);
        }
      }
    }
  }

  /**
   * Publish a state value for a previously registered entity. The
   * `timestamp` is the moment the upstream measurement was taken
   * (ISO-8601 string); when set it is forwarded to HA as an
   * attribute so the dashboard reflects the real reading time.
   */
  async publishState(
    deviceId: string,
    objectId: string,
    value: string | number | boolean,
    timestamp?: string,
  ): Promise<void> {
    this.assertKnownDevice(deviceId);
    const topic = `${deviceId}/${slugify(objectId)}/state`;
    const payload: SensorStatePayload = { value };
    if (timestamp !== undefined) payload.timestamp = timestamp;
    await this.publish(topic, JSON.stringify(payload), { qos: 0, retain: true });
  }

  /**
   * Convenience: register `entity` (idempotently) and publish its
   * state. The optional `timestamp` is passed through to
   * {@link publishState}.
   */
  async publishEntityState(
    deviceId: string,
    entity: HomeAssistantEntityConfig,
    value: string | number | boolean,
    timestamp?: string,
  ): Promise<void> {
    this.assertKnownDevice(deviceId);
    await this.registerEntity(entity);
    await this.publishState(deviceId, entity.objectId, value, timestamp);
  }

  /** Force the HA `availability` topic for the device. */
  async publishAvailability(online: boolean): Promise<void> {
    await this.publish(AVAILABILITY_TOPIC, online ? 'online' : 'offline', {
      qos: 0,
      retain: true,
      messageExpiryInterval: DISCOVERY_MESSAGE_EXPIRY_SECONDS,
    });
  }

  // ── periodic discovery refresh ──────────────────────────────

  /**
   * Republish the complete device config periodically so retained messages stay
   * alive (some brokers enforce a `message-expiry-interval` even on retained
   * messages).
   */
  private refreshAllDiscovery(): void {
    for (const device of this.options.devices) {
      if ((this.registered.get(device.deviceId)?.size ?? 0) === 0) continue;
      this.publishDeviceDiscovery(device.deviceId).catch((err) =>
        this.logger.warn(
          `Discovery refresh failed for ${device.deviceId}: ${(err as Error).message}`,
        ),
      );
    }
  }

  /**
   * Publish the complete device discovery payload from the registered
   * entity set. State updates use separate application-owned topics.
   */
  private async publishDeviceDiscovery(deviceId: string): Promise<void> {
    const components: Record<string, Record<string, unknown>> = {};
    const device = this.options.devices.find((item) => item.deviceId === deviceId);
    if (!device) throw new Error(`[HomeAssistant] unknown deviceId: ${deviceId}`);
    for (const [componentKey, entity] of this.registered.get(deviceId) ?? []) {
      const component: Record<string, unknown> = {
        p: 'sensor',
        unique_id: `${deviceId}_${componentKey}`,
        name: entity.name,
        state_topic: `${deviceId}/${componentKey}/state`,
        value_template: '{{ value_json.value }}',
        availability_topic: AVAILABILITY_TOPIC,
        payload_available: 'online',
        payload_not_available: 'offline',
      };
      if (entity.deviceClass) component['device_class'] = entity.deviceClass;
      if (entity.unitOfMeasurement) {
        component['unit_of_measurement'] = entity.unitOfMeasurement;
      }
      if (entity.icon) component['icon'] = entity.icon;
      components[componentKey] = component;
    }

    const configPayload = {
      dev: {
        ids: device.deviceId,
        name: device.sensor,
        ...(device.room ? { suggested_area: device.room } : {}),
      },
      o: { name: ORIGIN_NAME, sw: packageJson.version },
      cmps: components,
    };
    const configTopic = `${this.discovery()}/device/${deviceId}/config`;

    await this.publish(configTopic, JSON.stringify(configPayload), {
      qos: 0,
      retain: true,
      messageExpiryInterval: DISCOVERY_MESSAGE_EXPIRY_SECONDS,
    });
    this.discoveryDirty.delete(deviceId);
    this.logger.log(
      `Published discovery config for ${device.sensor} with ${Object.keys(components).length} component(s)`,
    );
  }

  private assertKnownDevice(deviceId: string): void {
    if (!this.options.devices.some((device) => device.deviceId === deviceId)) {
      throw new Error(`[HomeAssistant] unknown deviceId: ${deviceId}`);
    }
  }

  private sameEntityConfig(
    left: HomeAssistantEntityConfig,
    right: HomeAssistantEntityConfig,
  ): boolean {
    return (
      left.objectId === right.objectId &&
      left.name === right.name &&
      left.deviceClass === right.deviceClass &&
      left.unitOfMeasurement === right.unitOfMeasurement &&
      left.icon === right.icon
    );
  }

  // ── availability ────────────────────────────────────────────

  private discovery(): string {
    return this.options.discoveryPrefix ?? 'homeassistant';
  }

  /**
   * Publish `payload` to `topic` once the broker is reachable. QoS 0
   * with `retain: true` is the standard HA pattern for sensor data.
   */
  private publish(
    topic: string,
    payload: string,
    opts: {
      qos: 0 | 1 | 2;
      retain: boolean;
      /** MQTT v5 message-expiry interval in seconds (requires protocolVersion 5). */
      messageExpiryInterval?: number;
    },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.client) {
        reject(new Error('[HomeAssistant] client not initialised'));
        return;
      }
      const doPublish = (): void => {
        this.client!.publish(
          topic,
          payload,
          {
            qos: opts.qos,
            retain: opts.retain,
            ...(opts.messageExpiryInterval !== undefined
              ? {
                  properties: {
                    messageExpiryInterval: opts.messageExpiryInterval,
                  },
                }
              : {}),
          },
          (err) => {
            if (err) reject(err as Error);
            else resolve();
          },
        );
      };
      if (this.online) {
        doPublish();
      } else {
        this.deferredQueue.push({ resolve: doPublish, reject });
      }
    });
  }
}
