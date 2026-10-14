export interface HomeAssistantOptions {
  /**
   * Broker URL of the form `mqtts://user:password@host:port`
   * (or `mqtt://...`). Username and password are extracted from
   * the URL.
   */
  mqttUrl: string;
  /** JSON file containing the devices to expose in Home Assistant. */
  unitFactoriesFilePath: string;
  /** MQTT discovery prefix. Defaults to `homeassistant`. */
  discoveryPrefix?: string;
  /** MQTT client id. Defaults to `nestjs-ha-bridge`. */
  clientId?: string;
  /**
   * How often to republish all discovery configs (seconds).
   * Defaults to 3600 (1 hour). Set to 0 to disable periodic
   * refresh entirely.
   */
  discoveryRefreshIntervalSeconds?: number;
}

/** One unit factory exposed as a separate Home Assistant device. */
export interface HomeAssistantDevice {
  deviceId: string;
  sensor: string;
  room?: string;
}

/** Options after HomeAssistantModule has loaded the device config file. */
export type ResolvedHomeAssistantOptions = Omit<
  HomeAssistantOptions,
  'unitFactoriesFilePath'
> & { devices: HomeAssistantDevice[] };

/**
 * Description of a HA entity we want to expose. Mirrors the
 * subset of MQTT discovery payload that we actually use.
 */
export interface HomeAssistantEntityConfig {
  /** Unique stable id, e.g. `humidity`. Used as entity suffix. */
  objectId: string;
  /** Display name in HA. */
  name: string;
  /** MQTT sensor component class for icon + unit. */
  deviceClass?: string;
  /** Unit of measurement, e.g. `%` or `°C`. */
  unitOfMeasurement?: string;
  /** Icon override. */
  icon?: string;
}

export interface ParsedMqttUrl {
  protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
  host: string;
  port: number;
  username?: string;
  password?: string;
}
