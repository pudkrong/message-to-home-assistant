import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BridgeModule } from './bridge/bridge.module';
import type { BridgeOptions } from './bridge/bridge.types';
import type { MessagingOptions } from './messaging/messaging.types';

/**
 * Tiny entry point. The four infra modules
 * (Messaging / ReportMapping / UnitFactoryFilter / HomeAssistant)
 * are all wired inside {@link BridgeModule}, so `AppModule` only
 * owns shared infrastructure (config) and the composition root.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    BridgeModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService): BridgeOptions => ({
        messaging: buildMessagingOptions(config),
        reportMapping: {
          source: {
            type: 'json' as const,
            filePath: config.get<string>('REPORTS_CONFIG_PATH', './config/reports.json'),
          },
        },
        unitFactoryFilter: {
          source: {
            type: 'json' as const,
            filePath: config.get<string>(
              'UNIT_FACTORIES_CONFIG_PATH',
              './config/unit-factories.json',
            ),
          },
        },
        homeAssistant: {
          mqttUrl: config.get<string>('MQTT_URL', ''),
          sensor: config.get<string>('HA_SENSOR', ''),
          room: config.get<string>('HA_ROOM', ''),
          discoveryPrefix: config.get<string>('HA_DISCOVERY_PREFIX', 'homeassistant'),
          discoveryRefreshIntervalSeconds: parseOptionalNumber(
            config.get<string>('HA_DISCOVERY_REFRESH_SECONDS'),
          ),
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}

/**
 * Pick the message broker provider and assemble its options from
 * env vars. Defaults to `'azure'` so existing deployments
 * continue to work without setting `MESSAGE_PROVIDER`.
 *
 * To switch providers, set `MESSAGE_PROVIDER=kubemq` and the
 * `KUBEMQ_*` block; the Azure Service Bus backend is left
 * untouched and unused.
 */
function buildMessagingOptions(config: ConfigService): MessagingOptions {
  const provider = (config.get<string>('MESSAGE_PROVIDER', 'azure') ??
    'azure') as MessagingOptions['provider'];

  if (provider === 'azure') {
    return {
      provider: 'azure',
      azure: {
        connectionString: config.get<string>('SERVICE_BUS_CONNECTION_STRING'),
        namespace: config.get<string>('SERVICE_BUS_NAMESPACE'),
        queue: config.get<string>('SERVICE_BUS_QUEUE', ''),
      },
    };
  }

  if (provider === 'kubemq') {
    const address = config.get<string>('KUBEMQ_ADDRESS', '');
    const channel = config.get<string>('KUBEMQ_CHANNEL', '');
    if (!address || !channel) {
      throw new Error(
        '[Messaging] MESSAGE_PROVIDER=kubemq requires both KUBEMQ_ADDRESS and KUBEMQ_CHANNEL',
      );
    }
    const credentials = config.get<string>('KUBEMQ_TOKEN');
    const tlsRaw = config.get<string>('KUBEMQ_TLS', 'false')?.toLowerCase();
    const tlsValue = tlsRaw === 'true' ? true : tlsRaw === undefined ? undefined : false;
    const keepalivePingRaw = config.get<string>('KUBEMQ_KEEPALIVE_PING_MS');
    const keepalivePingMs = keepalivePingRaw ? Number(keepalivePingRaw) : undefined;
    return {
      provider: 'kubemq',
      kubemq: {
        address,
        channel,
        ...(credentials ? { credentials } : {}),
        ...(tlsValue !== undefined ? { tls: tlsValue } : {}),
        ...(config.get<string>('KUBEMQ_CLIENT_ID')
          ? { clientId: config.get<string>('KUBEMQ_CLIENT_ID')! }
          : {}),
        ...(config.get<string>('KUBEMQ_GROUP')
          ? { group: config.get<string>('KUBEMQ_GROUP')! }
          : {}),
        ...(keepalivePingMs !== undefined && Number.isFinite(keepalivePingMs)
          ? { keepalivePingMs }
          : {}),
      },
    };
  }

  throw new Error(`[Messaging] unknown MESSAGE_PROVIDER: ${provider}`);
}

/** Parse an env var into a finite number, or undefined when unset/invalid. */
function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
