export interface HomeAssistantOptions {
  /**
   * Broker URL of the form `mqtts://user:password@host:port`
   * (or `mqtt://...`). Username and password are extracted from
   * the URL.
   */
  mqttUrl: string;
  /**
   * Default device/identifier used by this app. Becomes part of
   * the MQTT topic and the HA `device.identifiers` list.
   */
  sensor: string;
  /**
   * HA `area` assigned to the device. Empty string skips the
   * suggestion.
   */
  room: string;
  /** MQTT discovery prefix. Defaults to `homeassistant`. */
  discoveryPrefix?: string;
  /** MQTT client id. Defaults to a slug of `sensor`. */
  clientId?: string;
}

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
