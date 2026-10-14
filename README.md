# service-bus-to-home-assistant

A NestJS 11 app that consumes JSON events from Azure Service Bus or KubeMQ,
filters them by unit factory and report ID, and publishes selected readings to
Home Assistant through MQTT discovery.

```text
src/
├── messaging/             # Azure Service Bus or KubeMQ transport
├── home-assistant/        # MQTT auto-discovery and sensor state publisher
├── report-mapping/        # reportId → Home Assistant entity mapping
├── unit-factory-filter/   # allow-list of unit factory numbers
└── bridge/                # project glue: transport → filter → map → HA
```

## Configuration

Copy `.env.example` to `.env`. Set the variables for the selected broker and
your MQTT broker:

| Variable | Purpose |
| --- | --- |
| `MESSAGE_PROVIDER` | `azure` (default) or `kubemq`. |
| `SERVICE_BUS_CONNECTION_STRING` | Azure Service Bus connection string. Optional if using namespace credentials; takes precedence when set. |
| `SERVICE_BUS_NAMESPACE` | Azure fully qualified namespace, e.g. `mybus.servicebus.windows.net`. Used with `DefaultAzureCredential` when no connection string is set. |
| `SERVICE_BUS_QUEUE` | Azure queue name. |
| `KUBEMQ_ADDRESS` | KubeMQ broker `host:port`. Required when `MESSAGE_PROVIDER=kubemq`. |
| `KUBEMQ_CHANNEL` | KubeMQ event channel. Required when `MESSAGE_PROVIDER=kubemq`. |
| `KUBEMQ_TOKEN` | Optional KubeMQ authentication token. |
| `KUBEMQ_TLS` | Optional KubeMQ TLS switch (`true` or `false`; default `false`). |
| `KUBEMQ_CLIENT_ID` | Optional client identifier for KubeMQ logs/metrics. |
| `KUBEMQ_GROUP` | Optional KubeMQ delivery group. Subscribers in the same group share events; different groups each receive them. |
| `KUBEMQ_KEEPALIVE_PING_MS` | Optional KubeMQ gRPC keepalive interval in milliseconds (default `30000`). |
| `REPORTS_CONFIG_PATH` | JSON report-to-entity mapping file (default `./config/reports.json`). |
| `UNIT_FACTORIES_CONFIG_PATH` | JSON unit-factory allow-list (default `./config/unit-factories.json`). |
| `MQTT_URL` | MQTT broker URL, typically `mqtt://user:password@host:port` or `mqtts://user:password@host:port`. |
| `HA_SENSOR` | Device identifier/name used in Home Assistant and MQTT topics. |
| `HA_ROOM` | Suggested Home Assistant area for the device; an empty value omits the suggestion. |
| `HA_DISCOVERY_PREFIX` | MQTT discovery root (default `homeassistant`). |
| `HA_DISCOVERY_REFRESH_SECONDS` | Discovery republish interval in seconds (default `3600`). Set to `0` to disable the timer. |

Azure authentication uses the connection string when supplied. Otherwise,
`DefaultAzureCredential` is used (for example, managed identity, environment
credentials, or Azure CLI credentials). KubeMQ producers should send UTF-8 JSON
with the same payload shape described below.

### `config/reports.json`

Only mapped `reportId`s are published. `description` becomes the stable entity
ID suffix; `name` is an optional display-name override. `deviceClass`,
`unitOfMeasurement`, and `icon` are optional Home Assistant discovery fields.

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

Messages are accepted only when `unitFactoryNumber` exactly matches an entry.
The `name` and `description` fields are optional metadata.

```json
[
  { "unitFactoryNumber": "1234-000000-100000", "name": "Simulator" }
]
```

## Message contract

Both transports deliver a JSON object in this shape:

```json
{
  "unitFactoryNumber": "1234-000000-100000",
  "version": 1,
  "timestamp": "2026-10-14T12:00:00Z",
  "data": [
    { "reportId": 10168, "value": 52.4 }
  ]
}
```

The bridge validates the top-level fields and every `data` entry before
processing the message. Unmapped report IDs are ignored.

## Run locally

The project declares Bun 1.4 as its package manager. Production runs on Node.js
(`start:prod` executes `node dist/main.js`).

```bash
bun install
bun run start:dev
bun run build
bun run start:prod
bun run typecheck
bun run test             # Jest
```

The app listens on port `3000` by default; set `PORT` to change it.

## Docker

The Dockerfile builds and runs the app on `node:24-alpine`; it uses `npm ci`
inside the build, not Bun. To run with the root `.env` file:

```bash
docker build -t ha .
docker run --rm --env-file .env -p 3000:3000 ha
```

Or use the included Compose file:

```bash
docker compose up --build
```

## Reusing the NestJS modules

`BridgeModule` composes the four infrastructure modules. Each module also has
its own `forRoot` / `forRootAsync` registration API and exports its service.
These modules are source code in this repository, not separately published
packages; another project must make the source available (for example, by
packaging or copying it) before importing it.

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BridgeModule } from './bridge/bridge.module';
import type { BridgeOptions } from './bridge/bridge.types';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BridgeModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): BridgeOptions => ({
        messaging: {
          provider: 'azure',
          azure: {
            connectionString: config.get('SERVICE_BUS_CONNECTION_STRING'),
            namespace: config.get('SERVICE_BUS_NAMESPACE'),
            queue: config.get('SERVICE_BUS_QUEUE', ''),
          },
        },
        reportMapping: {
          source: { type: 'json', filePath: './reports.json' },
        },
        unitFactoryFilter: {
          source: { type: 'json', filePath: './factories.json' },
        },
        homeAssistant: {
          mqttUrl: config.get('MQTT_URL', ''),
          sensor: config.get('HA_SENSOR', ''),
          room: config.get('HA_ROOM', ''),
        },
      }),
    }),
  ],
})
export class AppModule {}
```

Replace `provider: 'azure'` and its `azure` options with `provider: 'kubemq'`
and a `kubemq` options block to select KubeMQ. `BridgeModule.forRootAsync`
invokes its options factory once for each child module, so keep that factory
side-effect-free; use `forRoot` if resolving the options has side effects.

The report-mapping and unit-factory source types mention a future `database`
option, but only JSON loading is implemented. Selecting `database` currently
throws during startup; database-backed providers still need to be written.

## Message handling and delivery

1. The selected transport decodes/delivers a message body.
2. `BridgeService` validates the payload and checks the unit-factory allow-list.
3. For each mapped report, it publishes the discovery config (when needed) and
   a retained sensor state containing the value and source timestamp.

Azure Service Bus uses `peekLock` by default: successful handling completes the
message, while handler failure abandons it for redelivery (at-least-once
delivery). KubeMQ Events has no ack/nack in this adapter, so it does not provide
the same redelivery guarantee. KubeMQ reconnects its subscription with
backoff after subscription errors.

MQTT publishes use QoS 0 and retained messages. Topics use the discovery prefix
and slugified `HA_SENSOR` / entity IDs:

```text
<prefix>/sensor/<device>/<entity>/config
<prefix>/sensor/<device>/<entity>/state
<prefix>/sensor/<device>/availability
<prefix>/status                 # Home Assistant birth topic
```

## Restart and retained discovery

Home Assistant reconstructs MQTT-discovered entities from retained discovery
configs on the broker. This app republishes registered configs periodically
(hourly by default), when it connects/reconnects to MQTT, and when it receives
`online` on `<prefix>/status`. This helps restore discovery if the broker has
expired retained configs. Discovery and availability messages also set an
explicit MQTT v5 message-expiry interval of 24 hours; retained sensor state
messages do not use that expiry setting.

The app publishes retained availability and configures a retained `offline`
Last Will. If the app disconnects unexpectedly, Home Assistant can mark the
device unavailable instead of treating the last value as current.
