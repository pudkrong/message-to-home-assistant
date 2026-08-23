import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import mqtt, { MqttClient } from 'mqtt';
import { MODULE_OPTIONS_TOKEN } from './home-assistant.constants';
import {
  HomeAssistantEntityConfig,
  HomeAssistantOptions,
} from './home-assistant.types';
import { parseMqttUrl, slugify } from './util';

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
  private readonly registered = new Map<string, HomeAssistantEntityConfig>();
  private readonly deferredQueue: Deferred[] = [];
  private online = false;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: HomeAssistantOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.mqttUrl) {
      throw new Error('[HomeAssistant] MQTT_URL is required');
    }
    if (!this.options.sensor) {
      throw new Error('[HomeAssistant] HA_SENSOR is required (device identifier)');
    }

    this.parsed = parseMqttUrl(this.options.mqttUrl);

    const clientId =
      this.options.clientId ?? `nestjs-ha-bridge-${slugify(this.options.sensor)}`;
    const connectUrl = `${this.parsed.protocol}://${this.parsed.host}:${this.parsed.port}`;

    const deviceId = slugify(this.options.sensor);
    const availabilityTopic = `${this.discovery()}/sensor/${deviceId}/availability`;
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
        topic: availabilityTopic,
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
          this.logger.error(
            `Failed to subscribe to ${statusTopic}: ${err.message}`,
          );
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
      this.logger.log(
        'Home Assistant came online - re-announcing discovery configs',
      );
      this.publishAvailability(true).catch(() => undefined);
      this.refreshAllDiscovery();
    });

    this.client.on('reconnect', () => this.logger.warn('MQTT reconnecting...'));
    this.client.on('error', (err) =>
      this.logger.error(`MQTT error: ${err.message}`),
    );
    this.client.on('close', () => {
      this.online = false;
      this.logger.warn('MQTT connection closed');
    });

    const interval =
      (this.options.discoveryRefreshIntervalSeconds ?? 3600) * 1_000;
    if (interval > 0) {
      this.logger.log(
        `Discovery refresh every ${this.options.discoveryRefreshIntervalSeconds ?? 3600}s`,
      );
      this.refreshTimer = setInterval(
        () => this.refreshAllDiscovery(),
        interval,
      );
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
      this.logger.warn(
        `Failed to publish offline availability: ${(err as Error).message}`,
      );
    }
    await new Promise<void>((resolve) =>
      this.client?.end(false, {}, () => resolve()),
    );
  }

  /**
   * Publish the MQTT discovery config payload for `entity`. Idempotent:
   * repeated calls with the same `objectId` are a no-op.
   *
   * All sensors use the JSON state shape
   * (`{ value, timestamp? }`) and a `value_template` so the timestamp
   * from the upstream message lands in HA as an attribute instead
   * of being silently dropped.
   */
  async registerEntity(entity: HomeAssistantEntityConfig): Promise<void> {
    if (!entity.objectId) {
      throw new Error('[HomeAssistant] entity.objectId is required');
    }
    const uniqueId = `${slugify(this.options.sensor)}_${slugify(entity.objectId)}`;
    if (this.registered.has(uniqueId)) {
      return;
    }
    const deviceId = slugify(this.options.sensor);
    const { configTopic, configPayload } = this.buildDiscoveryConfig(
      entity,
      uniqueId,
      deviceId,
    );

    await this.publish(configTopic, JSON.stringify(configPayload), {
      qos: 0,
      retain: true,
      messageExpiryInterval: DISCOVERY_MESSAGE_EXPIRY_SECONDS,
    });
    this.registered.set(uniqueId, entity);
    this.logger.log(`Registered entity ${uniqueId} (${entity.name})`);
  }

  /**
   * Publish a state value for a previously registered entity. The
   * `timestamp` is the moment the upstream measurement was taken
   * (ISO-8601 string); when set it is forwarded to HA as an
   * attribute so the dashboard reflects the real reading time.
   */
  async publishState(
    objectId: string,
    value: string | number | boolean,
    timestamp?: string,
  ): Promise<void> {
    const deviceId = slugify(this.options.sensor);
    const topic = `${this.discovery()}/sensor/${deviceId}/${slugify(objectId)}/state`;
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
    entity: HomeAssistantEntityConfig,
    value: string | number | boolean,
    timestamp?: string,
  ): Promise<void> {
    await this.registerEntity(entity);
    await this.publishState(entity.objectId, value, timestamp);
  }

  /** Force the HA `availability` topic for the device. */
  async publishAvailability(online: boolean): Promise<void> {
    const deviceId = slugify(this.options.sensor);
    const topic = `${this.discovery()}/sensor/${deviceId}/availability`;
    await this.publish(topic, online ? 'online' : 'offline', {
      qos: 0,
      retain: true,
      messageExpiryInterval: DISCOVERY_MESSAGE_EXPIRY_SECONDS,
    });
  }

  // ── periodic discovery refresh ──────────────────────────────

  /**
   * Unconditionally republish every registered entity's discovery
   * config to the broker. Called on a timer so retained messages
   * don't expire (some brokers enforce a `message-expiry-interval`
   * even on retained messages).
   */
  private refreshAllDiscovery(): void {
    if (this.registered.size === 0) return;
    let count = 0;
    for (const [uniqueId, entity] of this.registered) {
      const deviceId = slugify(this.options.sensor);
      const { configTopic, configPayload } = this.buildDiscoveryConfig(
        entity,
        uniqueId,
        deviceId,
      );
      this.publish(configTopic, JSON.stringify(configPayload), {
        qos: 0,
        retain: true,
        messageExpiryInterval: DISCOVERY_MESSAGE_EXPIRY_SECONDS,
      }).catch((err) =>
        this.logger.warn(
          `Discovery refresh failed for ${uniqueId}: ${(err as Error).message}`,
        ),
      );
      count++;
    }
    this.logger.log(`Refreshed ${count} discovery config(s)`);
  }

  /**
   * Build the MQTT discovery config payload and topic for `entity`.
   *
   * Extracted into a helper so both `registerEntity` (first-time
   * registration) and `refreshAllDiscovery` (periodic re-publish)
   * use the same logic.
   */
  private buildDiscoveryConfig(
    entity: HomeAssistantEntityConfig,
    uniqueId: string,
    deviceId: string,
  ): { configTopic: string; configPayload: Record<string, unknown> } {
    const stateTopic = `${this.discovery()}/sensor/${deviceId}/${slugify(entity.objectId)}/state`;
    const availabilityTopic = `${this.discovery()}/sensor/${deviceId}/availability`;
    const configTopic = `${this.discovery()}/sensor/${deviceId}/${slugify(entity.objectId)}/config`;

    const configPayload: Record<string, unknown> = {
      unique_id: uniqueId,
      name: entity.name,
      state_topic: stateTopic,
      value_template: '{{ value_json.value }}',
      availability_topic: availabilityTopic,
      payload_available: 'online',
      payload_not_available: 'offline',
      device: {
        identifiers: [deviceId],
        name: this.options.sensor,
        ...(this.options.room ? { suggested_area: this.options.room } : {}),
      },
    };
    if (entity.deviceClass) configPayload['device_class'] = entity.deviceClass;
    if (entity.unitOfMeasurement) {
      configPayload['unit_of_measurement'] = entity.unitOfMeasurement;
    }
    if (entity.icon) configPayload['icon'] = entity.icon;

    return { configTopic, configPayload };
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
