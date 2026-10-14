# Home Assistant MQTT Discovery Best Practices

This guide documents how this project should publish MQTT discovery configuration and sensor values to Home Assistant (HA). It also describes the discovery subscriptions HA creates when MQTT discovery is enabled.

## Recommended approach for this project

Publish one **device discovery payload** for the AirC200 device. Put the humidity and temperature entities in its `cmps` map. Keep sensor values on application-owned state topics; discovery configuration and state values are separate MQTT messages.

This follows HA's device-discovery format and avoids publishing one discovery config per entity. It does **not** reduce HA's built-in discovery subscription filters or work around a broker limit of 10 subscriptions per client; see [HA's default discovery subscriptions](#ha-default-discovery-subscriptions).

## Topic layout

With the default discovery prefix, publish the device config to:

```text
homeassistant/device/airc200/config
```

Use the HA discovery prefix only for discovery and HA birth-message topics. Put sensor data and availability under a separate device namespace:

```text
airc200/humidity/state
airc200/temperature/state
airc200/availability
```

HA publishes its MQTT birth message to `homeassistant/status` by default. This project subscribes to that topic so it can republish discovery config when HA comes online. That is a subscription made by this project's MQTT client, not HA's discovery client.

## Example device discovery payload

Publish this JSON as a **retained** message to `homeassistant/device/airc200/config`:

```json
{
  "dev": {
    "ids": "airc200",
    "name": "AirC200"
  },
  "o": {
    "name": "ha-mqtt-bridge",
    "sw": "<project-version>"
  },
  "cmps": {
    "humidity": {
      "p": "sensor",
      "unique_id": "airc200_humidity",
      "name": "Humidity",
      "device_class": "humidity",
      "unit_of_measurement": "%",
      "state_topic": "airc200/humidity/state",
      "value_template": "{{ value_json.value }}",
      "availability_topic": "airc200/availability",
      "payload_available": "online",
      "payload_not_available": "offline"
    },
    "temperature": {
      "p": "sensor",
      "unique_id": "airc200_temperature",
      "name": "Temperature",
      "device_class": "temperature",
      "unit_of_measurement": "°C",
      "state_topic": "airc200/temperature/state",
      "value_template": "{{ value_json.value }}",
      "availability_topic": "airc200/availability",
      "payload_available": "online",
      "payload_not_available": "offline"
    }
  }
}
```

`dev` describes the physical device. `o` identifies the software publishing the config. Each `cmps` entry has a stable component key and a `p` platform; entity components also need a stable `unique_id`. Add manufacturer, model, serial number, or hardware/firmware versions only when the project has reliable values for them.

Publish each sensor value as JSON so its template can read `value`:

```json
{"value": 45.2, "timestamp": "2026-10-14T12:00:00Z"}
```

Use `online` and `offline` availability payloads consistently. The last-will message should publish retained `offline` if the bridge disconnects unexpectedly; on connection, publish retained `online`.

## Publishing behavior

1. **Publish a complete config.** Keep all currently supported entities in `cmps` whenever publishing an update. Build it from the complete entity registry, not just the most recently updated sensor.
2. **Retain config.** HA can process retained discovery config when its MQTT integration reconnects. This project also listens for HA's birth message and can republish config then. If using expiring retained messages, make sure the bridge reliably republishes them; otherwise configs can expire while the bridge is offline.
3. **Republish after configuration changes.** Send the full device payload after adding or changing an entity. State updates do not require republishing discovery config.
4. **Retain latest state when useful.** Retained state lets HA show the last value immediately after reconnect. Keep availability so HA can distinguish a last-known value from a currently reachable device.
5. **Use stable identifiers.** Treat the device identifier, component keys, and entity `unique_id`s as persistent identifiers. Derive them from immutable device/report IDs, not display names that may change.
6. **Remove entities explicitly.** To remove an entire device, publish an empty retained payload to its device discovery topic. To remove one component, follow HA's device-discovery removal procedure: publish that component with only its `p` field, then publish the updated complete payload with that component omitted.

## HA default discovery subscriptions

When MQTT discovery is enabled, HA subscribes to wildcard **filters**, not one exact topic per device. With the default prefix, the filters are:

```text
homeassistant/<component>/+/config
homeassistant/<component>/+/+/config
homeassistant/device/+/config
homeassistant/device/+/+/config
```

The two component patterns cover discovery topics with and without the optional `node_id`. HA creates both patterns for each supported component type. The two `device` patterns cover device discovery topics with and without that optional level.

The current Home Assistant Core source lists these supported component types:

```text
alarm_control_panel
binary_sensor
button
camera
climate
cover
date
datetime
device_automation
device_tracker
event
fan
humidifier
image
infrared
lawn_mower
light
lock
notify
number
scene
sensor
siren
select
switch
text
time
update
vacuum
valve
water_heater
```

That is 31 component types in the referenced source: 62 component filters, plus two device-discovery filters. The list can change between HA versions. The broker may also see state and availability subscriptions created from each discovered entity. Therefore, publishing one device config does **not** make HA subscribe only to this device's discovery topic, and it does not by itself solve a 10-filter-per-client broker limit.

## Troubleshooting the EMQX subscription limit

If HA reports that it exceeds EMQX's per-client subscription limit, device discovery is not the fix: HA still installs its generic wildcard discovery filters. Options are to increase the broker limit if the plan permits it, or disable HA discovery and configure the required MQTT entities manually. Verify the actual filters at the broker because HA also subscribes to entity state and availability topics.

## References

- [Home Assistant MQTT integration: discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery)
- [Home Assistant MQTT integration: device discovery payload](https://www.home-assistant.io/integrations/mqtt/#device-discovery-payload)
- [Home Assistant Core MQTT discovery subscriptions](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mqtt/discovery.py)
- [Home Assistant Core supported MQTT components](https://github.com/home-assistant/core/blob/dev/homeassistant/components/mqtt/const.py)

> The Core links above use the `dev` branch. Check the corresponding release tag when validating behavior for a specific installed HA version.
