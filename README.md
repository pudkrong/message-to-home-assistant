# service-bus-to-home-assistant

A NestJS 11 app that subscribes to an Azure Service Bus queue and publishes
selected readings to Home Assistant over MQTT auto-discovery.

The project is split into four small, reusable modules plus one
project-specific bridge module:

```
src/
├── messaging/             # broker-agnostic transport (Azure Service Bus or KubeMQ)
├── home-assistant/        # generic — MQTT auto-discovery publisher
├── report-mapping/        # generic — reportId -> HA entity mapping (JSON or DB)
├── unit-factory-filter/   # generic — allow-list of unit factory numbers
└── bridge/                # project glue (broker → filter → map → HA)
```

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Notes |
| --- | --- |
| `SERVICE_BUS_CONNECTION_STRING` | Optional. If set, used directly. |
| `SERVICE_BUS_NAMESPACE` | Fully-qualified namespace, e.g. `mybus.servicebus.windows.net`. Used with **DefaultAzureCredential** (managed identity, `az` cli, env, etc.) when no connection string is supplied. |
| `SERVICE_BUS_QUEUE` | Queue name. |
| `REPORTS_CONFIG_PATH` | JSON file describing reportId → HA entity mappings. |
| `UNIT_FACTORIES_CONFIG_PATH` | JSON file of allowed `unitFactoryNumber` values. |
| `MQTT_URL` | Broker URL of the form `mqtts://user:password@host:port`. |
| `HA_SENSOR` | Device identifier / display name for the HA device. |
| `HA_ROOM` | `suggested_area` on the HA device. |
| `HA_DISCOVERY_PREFIX` | (default `homeassistant`) MQTT discovery root. |

### `config/reports.json`

Only listed `reportId`s are surfaced in HA. Each entry can carry the
optional HA fields `deviceClass`, `unitOfMeasurement`, `icon`.

```json
[
  {
    "reportId": 10168,
    "description": "humidity",
    "name": "Humidity",
    "deviceClass": "humidity",
    "unitOfMeasurement": "%"
  }
]
```

### `config/unit-factories.json`

```json
[
  { "unitFactoryNumber": "1234-000000-100000", "name": "Simulator" }
]
```

## Run

[Bun](https://bun.sh) 1.4 is the package manager and runtime.

```bash
bun install
bun run start:dev      # nest start --watch
bun run start:prod     # bun dist/main.js
bun run typecheck      # tsc --noEmit
bun test               # jest
```

## Docker

The image uses `oven/bun:1.4-alpine`. Build locally first — Bun's JSC
heap runs out of memory when cross-compiling inside QEMU emulation.

```bash
bun run build            # compile TypeScript → dist/
podman build --platform linux/amd64 -t ha .
podman run --rm --env-file .env ha
```

## Reusing the modules in another project

Each module exposes a `forRoot` (or `forRootAsync({ useFactory })`)
API and exports only its public service, so they can be plugged into
any NestJS app. `MessagingModule` requires you to pick exactly one
broker backend via `provider: 'azure' | 'kubemq'`:

```ts
import { ConfigModule } from '@nestjs/config';
import { MessagingModule } from 'my-libs/messaging';
import { HomeAssistantModule } from 'my-libs/home-assistant';
import { ReportMappingModule } from 'my-libs/report-mapping';
import { UnitFactoryFilterModule } from 'my-libs/unit-factory-filter';

@Module({
  imports: [
    MessagingModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        provider: 'azure',
        azure: {
          connectionString: cfg.get('SERVICE_BUS_CONNECTION_STRING'),
          namespace: cfg.get('SERVICE_BUS_NAMESPACE'),
          queue: cfg.get('SERVICE_BUS_QUEUE'),
        },
      }),
      inject: [ConfigService],
    }),
    ReportMappingModule.forRootAsync({ useFactory: () => ({ source: { type: 'json', filePath: './reports.json' } }) }),
    UnitFactoryFilterModule.forRootAsync({ useFactory: () => ({ source: { type: 'json', filePath: './factories.json' } }) }),
    HomeAssistantModule.forRootAsync({
      useFactory: (cfg: ConfigService) => ({
        mqttUrl: cfg.get('MQTT_URL'),
        sensor: cfg.get('HA_SENSOR'),
        room: cfg.get('HA_ROOM'),
      }),
      inject: [ConfigService],
    }),
  ],
})
export class MyAppModule {}
```

### Swapping JSON for a database later

`ReportMappingSource` and `UnitFactoryFilterSource` are discriminated
unions. Adding `type: 'database'` and a separate provider that injects
a repository is enough — the bridge and HA modules stay untouched.

## How a message flows

1. `AzureServiceBusService` receives a queue message (peekLock by default).
2. `BridgeService` validates the `PayloadV1` shape and checks the
   `unitFactoryNumber` against the allow-list.
3. For every `data` entry whose `reportId` is mapped, the bridge
   calls `HomeAssistantService.publishEntityState`, which publishes
   the discovery config (once) and a retained `state` update.
4. QoS is `0`, retain is `true` — the standard HA sensor pattern.

MQTT topic layout:

```
homeassistant/sensor/<device>/<entity>/config
homeassistant/sensor/<device>/<entity>/state
homeassistant/sensor/<device>/availability
```
