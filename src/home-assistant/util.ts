import type { ParsedMqttUrl } from './home-assistant.types';

/**
 * Parse an MQTT broker URL of the form
 * `mqtt(s)://[user[:password]@]host[:port]`.
 *
 * Throws when the URL is structurally invalid.
 */
export function parseMqttUrl(raw: string): ParsedMqttUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[HomeAssistant] invalid MQTT_URL: ${raw}`);
  }
  const proto = url.protocol.replace(':', '') as ParsedMqttUrl['protocol'];
  if (!['mqtt', 'mqtts', 'ws', 'wss'].includes(proto)) {
    throw new Error(`[HomeAssistant] unsupported protocol: ${proto}`);
  }
  if (!url.hostname) {
    throw new Error(`[HomeAssistant] MQTT_URL is missing hostname: ${raw}`);
  }
  const defaultPort = proto === 'mqtts' || proto === 'wss' ? 8883 : 1883;
  const port = url.port ? Number(url.port) : defaultPort;

  return {
    protocol: proto,
    host: url.hostname,
    port,
    username: url.username || undefined,
    password: url.password || undefined,
  };
}

/** Make a string safe for HA `unique_id` / MQTT topic segments. */
export function slugify(value: string): string {
  return value
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}
