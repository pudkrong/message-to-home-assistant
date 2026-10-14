# Secure Mosquitto with Docker Compose and Tailscale

This guide runs Eclipse Mosquitto in Docker and makes it reachable only over a Tailscale network. Mosquitto still requires MQTT authentication and topic authorization. Tailscale adds private, encrypted network access; it does not replace broker credentials or ACLs.

## Security model

Use three separate controls:

1. **Network access:** Tailscale encrypts traffic between tailnet devices. Do not forward MQTT ports from the public internet.
2. **Tailnet authorization:** Tailscale policy allows only the Home Assistant and publisher devices to reach TCP port `1883` on the broker.
3. **MQTT authorization:** Mosquitto requires a username/password and grants each MQTT client only the topic access it needs.

The example below assumes a Linux Docker host with Tailscale installed on the host. Docker publishes MQTT only on the host's Tailscale IP. Tailscale and MQTT credentials remain separate: a tailnet device still needs a valid MQTT account.

## Prerequisites

- A Linux server with Docker Engine and the Docker Compose plugin.
- Tailscale installed and connected on the server and MQTT client devices.
- Permission to update the tailnet access-control policy.
- The server's Tailscale IPv4 address. Find it with `tailscale ip -4` after Tailscale connects.

This host-IP binding pattern is for Linux Docker Engine. Docker Desktop on macOS or Windows runs containers inside a VM and may not be able to bind a container port to the host's Tailscale interface this way.

## Files

Create this layout beside `compose.yaml`:

```text
.
├── .env
├── compose.yaml
└── mosquitto/
    └── config/
        ├── mosquitto.conf
        └── acl
```

Create the password file in `mosquitto/config/` in the next section. Do not commit that file or MQTT passwords to source control.

## Configure MQTT accounts

Create separate MQTT accounts for Home Assistant and the publisher. Do not reuse one account for every client.

Create the first password file interactively. `-c` creates or overwrites the file, so use it only for the first account:

```sh
mkdir -p mosquitto/config
docker run --rm -it \
  -v "$PWD/mosquitto/config:/mosquitto/config" \
  eclipse-mosquitto:2 \
  mosquitto_passwd -c /mosquitto/config/passwords homeassistant
```

Add the publisher without `-c`, which preserves the existing account:

```sh
docker run --rm -it \
  -v "$PWD/mosquitto/config:/mosquitto/config" \
  eclipse-mosquitto:2 \
  mosquitto_passwd /mosquitto/config/passwords airc200-publisher
```

The command prompts for each password. Ensure the resulting file is readable by the Mosquitto process, but not broadly readable by other host users. Back it up securely.

## Configure Mosquitto

Create `mosquitto/config/mosquitto.conf`:

```conf
persistence true
persistence_location /mosquitto/data/
log_dest stdout

per_listener_settings true
listener 1883
allow_anonymous false
password_file /mosquitto/config/passwords
acl_file /mosquitto/config/acl
```

`allow_anonymous false` rejects clients without credentials. The password file authenticates users. The ACL file limits their publish and subscribe permissions.

Create `mosquitto/config/acl`:

```conf
user homeassistant
topic read homeassistant/#
topic read airc200/+/state
topic read airc200/availability
topic write homeassistant/status

user airc200-publisher
topic write homeassistant/device/airc200/config
topic write airc200/+/state
topic write airc200/availability
topic read homeassistant/status
```

HA needs read access to the discovery prefix because it subscribes to broad discovery filters, as well as read access to the sensor state and availability topics. The publisher can write the device config, sensor values, and availability; it can read HA's birth topic so it can republish discovery when HA comes online. Adjust these rules to match your actual topics and clients.

## Bind the broker to the Tailscale interface

Put the server's Tailscale IPv4 address in `.env`:

```dotenv
TAILSCALE_IP=100.64.0.10
```

Replace the example address with the result of `tailscale ip -4`. Ensure Tailscale is connected before starting Compose.

Create `compose.yaml`:

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    ports:
      - "${TAILSCALE_IP:?Set TAILSCALE_IP in .env}:1883:1883"
    volumes:
      - ./mosquitto/config:/mosquitto/config:ro
      - mosquitto-data:/mosquitto/data

volumes:
  mosquitto-data:
```

The host-side port binding is the important part: it publishes MQTT on the Tailscale IP, not on every host interface. Do not add a router port-forward or bind `1883` to `0.0.0.0`. Keep untrusted containers off this Compose network; containers on the same Docker network may be able to reach the broker directly.

Start the broker:

```sh
docker compose up -d
docker compose logs -f mosquitto
```

Use the broker's Tailscale IP or MagicDNS name as the MQTT host in Home Assistant and publisher configuration. Use port `1883`, with the distinct MQTT username and password for each client.

## Limit Tailscale access

Add a narrow grant to the tailnet policy. Tag the broker and only the authorized client devices. Merge this into the existing policy; do not replace other policy rules blindly.

```json
{
  "tagOwners": {
    "tag:mqtt-broker": ["autogroup:admin"],
    "tag:mqtt-client": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:mqtt-client"],
      "dst": ["tag:mqtt-broker"],
      "ip": ["tcp:1883"]
    }
  ]
}
```

Apply `tag:mqtt-broker` to the server and `tag:mqtt-client` only to the HA and publisher devices that need broker access. Tailscale grants are additive: an existing broad grant can still allow access. Review the full tailnet policy and remove broad access rules if the goal is to restrict the broker to these clients.

## Verify access

1. Confirm the broker container is healthy and `docker compose logs mosquitto` shows a listener on port `1883` without configuration errors.
2. From an authorized tailnet device, connect to the broker's Tailscale IP or MagicDNS name using the correct MQTT credentials. Confirm HA receives the retained discovery config and sensor state.
3. From an unauthorized tailnet device, confirm TCP `1883` is denied by Tailscale policy.
4. Try an MQTT connection with no password and with a valid account but a disallowed topic. Mosquitto should reject the connection or deny the topic operation.
5. From outside the tailnet, confirm the server has no public port forward and that port `1883` is not reachable.

## Important limits

- Tailscale's WireGuard transport encrypts traffic between tailnet devices. The broker still sees MQTT credentials and messages, so secure the host and password file.
- Tailnet access does not identify a user to Mosquitto. Mosquitto sees the MQTT username, so keep broker accounts and ACLs enabled.
- If MQTT clients must connect outside the tailnet, configure TLS on Mosquitto and use a secure listener. Do not expose plaintext port `1883` publicly.
- Pin a tested Mosquitto image version or digest for production rather than relying indefinitely on a moving tag.

## References

- [Mosquitto authentication methods](https://mosquitto.org/documentation/authentication-methods/)
- [Mosquitto ACL file](https://mosquitto.org/documentation/plugins/acl-file/)
- [Tailscale Docker Compose guide](https://tailscale.com/docs/features/containers/docker/how-to/connect-docker-container)
- [Tailscale access-control grants](https://tailscale.com/docs/reference/examples/grants)
