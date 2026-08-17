import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BridgeModule } from './bridge/bridge.module';
import {
  BridgeOptions,
} from './bridge/bridge.types';

/**
 * Tiny entry point. The four infra modules
 * (ServiceBus / ReportMapping / UnitFactoryFilter / HomeAssistant)
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
        serviceBus: {
          connectionString: config.get<string>('SERVICE_BUS_CONNECTION_STRING'),
          namespace: config.get<string>('SERVICE_BUS_NAMESPACE'),
          queue: config.get<string>('SERVICE_BUS_QUEUE', ''),
        },
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
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
