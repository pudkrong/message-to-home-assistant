# Secure EMQX with Docker Compose and Tailscale

This guide runs EMQX in Docker and makes MQTT reachable only over a Tailscale network. EMQX still requires MQTT authentication and topic authorization. Tailscale adds private, encrypted network access; it does not replace broker credentials or topic permissions.

## Security model

Use three separate controls:

1. **Network access:** Tailscale encrypts traffic between tailnet devices. Do not forward MQTT or Dashboard ports from the public internet.
2. **Tailnet authorization:** Tailscale policy allows only MQTT client devices to reach TCP port `1883`, and only administrator devices to reach the EMQX Dashboard on TCP port `18083`.
3. **MQTT authorization:** EMQX requires a username/password and grants each MQTT client only the topic access it needs.

The example assumes a Linux Docker host with Tailscale installed on the host. Docker publishes MQTT and the Dashboard only on the host's Tailscale IP. Use separate EMQX accounts for each MQTT client, and a separate Dashboard administrator account. A tailnet device still needs valid MQTT credentials to use the broker.

## Prerequisites

- A Linux server with Docker Engine and the Docker Compose plugin.
- Tailscale installed and connected on the server, MQTT client devices, and an administrator device.
- Permission to update the tailnet access-control policy.
- The server's Tailscale IPv4 address. Find it with `tailscale ip -4` after Tailscale connects.

This host-IP binding pattern is for Linux Docker Engine. Docker Desktop on macOS or Windows runs containers inside a VM and may not be able to bind a container port to the host's Tailscale interface this way.

## Start EMQX

Create this layout beside `compose.yaml`:

```text
.
├── .env
├── compose.yaml
└── emqx/
    └── etc/
        ├── acl.conf
        └── base.hocon
```

Put the server's Tailscale IPv4 address in `.env`:

```dotenv
TAILSCALE_IP=100.64.0.10
```

Replace the example address with the result of `tailscale ip -4`. Ensure Tailscale is connected before starting Compose.

Create `emqx/etc/base.hocon` to use only EMQX's file-based authorizer and make unmatched requests fail closed:

```hocon
authorization {
  deny_action = ignore
  no_match = deny
  sources = [
    {
      type = file
      enable = true
      path = "etc/acl.conf"
    }
  ]
}
```

Create `emqx/etc/acl.conf` with the topic permissions below. These rules use EMQX's Erlang-style ACL format; do not add a catch-all allow rule.

```erlang
{allow, {user, "homeassistant"}, subscribe, ["homeassistant/#"]}.
{allow, {user, "homeassistant"}, subscribe, ["airc200/+/state"]}.
{allow, {user, "homeassistant"}, subscribe, ["airc200/availability"]}.
{allow, {user, "homeassistant"}, publish, ["homeassistant/status"]}.

{allow, {user, "airc200-publisher"}, publish, ["homeassistant/device/airc200/config"]}.
{allow, {user, "airc200-publisher"}, publish, ["airc200/+/state"]}.
{allow, {user, "airc200-publisher"}, publish, ["airc200/availability"]}.
{allow, {user, "airc200-publisher"}, subscribe, ["homeassistant/status"]}.
```

Create `compose.yaml`:

```yaml
services:
  emqx:
    image: emqx/emqx:6.2.3
    restart: unless-stopped
    ports:
      - "${TAILSCALE_IP:?Set TAILSCALE_IP in .env}:1883:1883"
      - "${TAILSCALE_IP:?Set TAILSCALE_IP in .env}:18083:18083"
    volumes:
      - ./emqx/etc/base.hocon:/opt/emqx/etc/base.hocon:ro
      - ./emqx/etc/acl.conf:/opt/emqx/etc/acl.conf:ro
      - emqx-data:/opt/emqx/data

volumes:
  emqx-data:
```

The host-side bindings publish MQTT and the Dashboard on the Tailscale IP, not on every host interface. Port `18083` is the management Dashboard; do not grant it to ordinary MQTT clients. Do not add a router port-forward or bind either port to `0.0.0.0`. Keep untrusted containers off this Compose network; containers on the same Docker network may be able to reach EMQX directly.

The named data volume preserves EMQX's built-in database contents, including MQTT users. The mounted `base.hocon` and `acl.conf` files live on the host; back them up and keep them with your deployment. Keep the named volume when recreating or upgrading the container. Pin and test a specific EMQX image version for production rather than relying on a moving tag.

Start EMQX:

```sh
docker compose up -d
docker compose logs -f emqx
```

## Secure the Dashboard and configure MQTT authentication

Open `http://<TAILSCALE_IP>:18083` from an administrator device allowed by the Tailscale policy below. On a first install, EMQX Dashboard's default login is `admin` / `public`; change that password immediately. Do not reuse the Dashboard password for MQTT clients.

In the Dashboard, configure password authentication backed by EMQX's built-in database:

1. Go to **Access Control → Authentication** and create an authenticator.
2. Select **Password-Based** for the mechanism and **Built-in Database** for the backend. Use `username` as the user ID type and keep a secure password-hashing option enabled.
3. Add distinct users named `homeassistant` and `airc200-publisher`, each with a unique strong password.

Do not add an anonymous MQTT authenticator. Verify that a client without a valid username and password cannot connect. Keep the Dashboard administrator credentials separate from these MQTT accounts.

## Configure per-user topic permissions

The Home Assistant account can read the discovery prefix, sensor state, and availability topics, and publish its birth/status message. The publisher can write discovery config, sensor values, and availability, and read Home Assistant's status topic so it can republish discovery when Home Assistant comes online. EMQX's file ACL rules do not restrict retained messages by default. Adjust the rules to match your actual topics and clients; do not broaden them to `#`.

The authorization source list in `base.hocon` deliberately contains only this file authorizer. That avoids a default or additional authorizer granting broader access before these per-user rules are checked. If you change either file, restart EMQX so it loads the updated configuration and ACL:

```sh
docker compose restart emqx
```

## Limit Tailscale access

Add narrow grants to the tailnet policy. Tag the broker, MQTT client devices, and administrator devices separately. Merge this into the existing policy; do not replace other policy rules blindly.

```json
{
  "tagOwners": {
    "tag:mqtt-broker": ["autogroup:admin"],
    "tag:mqtt-client": ["autogroup:admin"],
    "tag:mqtt-admin": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:mqtt-client"],
      "dst": ["tag:mqtt-broker"],
      "ip": ["tcp:1883"]
    },
    {
      "src": ["tag:mqtt-admin"],
      "dst": ["tag:mqtt-broker"],
      "ip": ["tcp:18083"]
    }
  ]
}
```

Apply `tag:mqtt-broker` to the server, `tag:mqtt-client` only to the Home Assistant and publisher devices, and `tag:mqtt-admin` only to administrator devices. If an administrator device also needs MQTT access, give it the client tag as well. Tailscale grants are additive: an existing broad grant can still allow access. Review the full tailnet policy and remove broad access rules if the goal is to restrict the broker and Dashboard to these devices.

## Connect clients and verify access

Use the broker's Tailscale IP or MagicDNS name as the MQTT host in Home Assistant and publisher configuration. Use port `1883` and the distinct MQTT username and password for each client.

1. Confirm `docker compose logs emqx` shows successful startup without configuration errors.
2. From an authorized MQTT client, connect with its credentials. Confirm Home Assistant receives the retained discovery config and sensor state.
3. From an unauthorized tailnet device, confirm TCP `1883` is denied. From a non-administrator device, confirm TCP `18083` is denied.
4. Verify that a connection without valid MQTT credentials fails, and that a valid user cannot publish or subscribe to a topic outside its permissions.
5. From outside the tailnet, confirm the server has no public port forward and neither port `1883` nor `18083` is reachable.

## Important limits

- Tailscale's WireGuard transport encrypts traffic between tailnet devices. EMQX still sees MQTT credentials and messages, so secure the host, Dashboard credentials, and data volume.
- Tailnet access does not identify a user to EMQX. EMQX authorizes MQTT operations using the MQTT username and configured rules; keep both authentication and authorization enabled.
- If MQTT clients must connect outside the tailnet, configure TLS on EMQX and use a secure listener. Do not expose plaintext port `1883` publicly.
- Keep the Dashboard private. Do not expose port `18083` to the public internet or grant it to all tailnet devices.
- Back up the EMQX data volume securely. It contains broker state and built-in database data.

## References

- [EMQX Docker deployment](https://docs.emqx.com/en/emqx/latest/deploy/install-docker.html)
- [EMQX built-in database authentication](https://docs.emqx.com/en/emqx/latest/access-control/authn/mnesia.html)
- [EMQX built-in database authorization](https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html)
- [EMQX Dashboard](https://docs.emqx.com/en/emqx/latest/dashboard/introduction.html)
- [Tailscale Docker Compose guide](https://tailscale.com/docs/features/containers/docker/how-to/connect-docker-container)
- [Tailscale access-control grants](https://tailscale.com/docs/reference/examples/grants)
