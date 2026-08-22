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

    this.client = mqtt.connect(connectUrl, {
      clientId,
      username: this.parsed.username,
      password: this.parsed.password,
      reconnectPeriod: 5000,
      clean: true,
    });

    this.client.on('connect', () => {
      this.online = true;
      this.logger.log(
        `Connected to MQTT broker ${this.parsed?.host}:${this.parsed?.port}` +
          ` as ${this.parsed?.username ?? '<anonymous>'}`,
      );
      // Push retained "online" so HA immediately marks us available.
      this.publishAvailability(true).catch(() => undefined);
      while (this.deferredQueue.length > 0) {
        this.deferredQueue.shift()?.resolve();
      }
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
      (this.options.discoveryRefreshIntervalSeconds ?? 86400) * 1_000;
    if (interval > 0) {
      this.logger.log(
        `Discovery refresh every ${this.options.discoveryRefreshIntervalSeconds ?? 86400}s`,
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

    await this.publish(
      configTopic,
      JSON.stringify(configPayload),
      { qos: 0, retain: true },
    );
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
    opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.client) {
        reject(new Error('[HomeAssistant] client not initialised'));
        return;
      }
      const doPublish = (): void => {
        this.client!.publish(topic, payload, opts, (err) => {
          if (err) reject(err as Error);
          else resolve();
        });
      };
      if (this.online) {
        doPublish();
      } else {
        this.deferredQueue.push({ resolve: doPublish, reject });
      }
    });
  }
}
