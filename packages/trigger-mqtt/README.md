# MQTT trigger — `@nanobpm/nano-ide-trigger-mqtt`

> Turn any MQTT message into a running process. Subscribe to a broker topic and
> let each message **start a process** or **correlate into a running one** — the
> *"when this happens…"* half of a Zapier-style automation, for your own apps.

This is a pack on the **`nano-ide-trigger-*` marketplace axis** for the Nano /
Urban RAD console. Installing it adds a new trigger source **kind** — `mqtt` —
that any App can declare. The pack ships a small out-of-process **driver** that
the runtime auto-launches and supervises; the driver only *produces* events, and
the runtime owns the durable inbox, dispatch, retry, and lifecycle (ADR 0025).

## Why you'd want it

MQTT is the lingua franca of IoT and home automation. With this pack an Urban App
can react to anything that speaks MQTT:

- **Home automation** — Home Assistant, Zigbee2MQTT, Tasmota, ESPHome, Shelly…
  a door opens, a sensor crosses a threshold, a button is pressed → kick off a
  process.
- **Industrial / edge** — PLCs and gateways publishing telemetry over MQTT/MQTTS.
- **Your own devices** — an ESP32 publishing `{ "value": 21.4 }` becomes a typed
  event your process reasons about.

## Install

Install it into your Urban workspace's extensions like any other pack — from the
console **Extensions** marketplace (search "MQTT"), or from the CLI:

```bash
c8ctl load plugin @nanobpm/nano-ide-trigger-mqtt
```

Once installed, `mqtt` shows up as a recognised source kind in the console
**Triggers** panel, and you can declare triggers of `type: "mqtt"`.

## Use it in an App

Declare a trigger of type `mqtt` in your `nano.app.json`:

```json
{
  "triggers": [
    {
      "id": "room-temp",
      "type": "mqtt",
      "config": {
        "url": "mqtt://localhost:1883",
        "topics": "home/+/temperature",
        "qos": "1"
      },
      "connection": "broker",
      "action": {
        "start": "handle-reading",
        "variables": "{ room: split(body.topic, \"/\")[2], celsius: body.payload.value }"
      }
    }
  ],
  "connections": {
    "broker": {
      "type": "mqtt",
      "username": "{{ env.MQTT_USER }}",
      "password": "{{ env.MQTT_PASS }}"
    }
  }
}
```

Each received message is delivered to the App as the event **body**:

```json
{
  "topic": "home/kitchen/temperature",
  "payload": { "value": 21.4 },
  "ts": "2026-07-24T00:00:00.000Z"
}
```

- `topic` — the concrete topic the message arrived on (wildcards resolved).
- `payload` — the message payload parsed as JSON when possible, else the raw
  UTF-8 string.
- `ts` — ISO-8601 receive time.

Reference these in the action's FEEL (`variables` / `correlationKey`), e.g.
`body.payload.value`, `split(body.topic, "/")[2]`.

## Configuration

| field | required | default | notes |
| --- | --- | --- | --- |
| `url` | yes\* | `mqtt://localhost:1883` | Broker URL. Schemes: `mqtt://`, `mqtts://` (TLS), `ws://`, `wss://`. A `connection.url` overrides this. |
| `topics` | yes | — | Topic filter(s) to subscribe to. Comma-separate several. MQTT wildcards `+` (single level) and `#` (multi level) are allowed, e.g. `home/+/temperature`, `sensors/#`. |
| `qos` | no | `1` | Subscription QoS: `0` (at most once), `1` (at least once), `2` (exactly once). |

\* A broker URL is required, but it may come from either `config.url` or the
referenced `connection.url`.

### Credentials

Put credentials in a `connections[]` entry (referenced by the trigger's
`connection`), **never inline** in `config` — secrets should be env templates
(`{{ env.VAR }}`) the host resolves. The connection object may supply:

| key | notes |
| --- | --- |
| `url` | Broker URL; overrides `config.url`. |
| `username` / `password` | Broker credentials. |
| `clientId` | Fixed MQTT client id (otherwise the library picks one). |

## Delivery semantics

The driver POSTs every received message to the trigger ingress with a **stable
idempotency key**, and the runtime's inbox is **at-least-once**: a message that
is briefly un-POSTable (ingress hiccup) is retried with backoff, and a retried
delivery is collapsed rather than double-processed. Design your process actions
to tolerate the occasional duplicate (idempotent starts / correlation keys).

MQTT itself only redelivers **retained** messages on reconnect; live messages
published while the driver was down are not replayed.

## How it runs

The runtime launches `driver.ts` as a supervised child process — **Node ≥ 22.6**
with `--experimental-strip-types` (the default), or **Deno** — passing the
trigger's context in the environment:

| env var | value |
| --- | --- |
| `NANOBPMN_HOOK_URL` | the ingress endpoint the driver POSTs events to |
| `NANOBPMN_TRIGGER_CONFIG` | JSON of the trigger's `config` |
| `NANOBPMN_TRIGGER_CONNECTION` | JSON of the referenced connection, or `null` |
| `NANOBPMN_WEBHOOK_TOKEN` | shared secret presented as `X-Webhook-Token` (if the trigger sets `auth`) |
| `NANOBPMN_PROJECT` / `NANOBPMN_TRIGGER_ID` / `NANOBPMN_TRIGGER_TYPE` | identity, for logs |

On crash the driver is restarted with capped backoff; on App stop it receives
`SIGTERM` and disconnects cleanly. Its stdout/stderr stream into the App's
trigger log, so `[mqtt] connected` / `subscribed` / errors are visible in the
console.

## Troubleshooting

- **No events arriving** — check the App's trigger log for `[mqtt] connected` and
  `[mqtt] subscribed: <topic>@<qos>`. If you see `reconnecting…` in a loop, the
  broker URL or credentials are wrong.
- **`no topics configured`** — set `config.topics` (comma-separated); the driver
  refuses to start without at least one.
- **`ingress rejected event (401/403)`** — the trigger declares an `auth` secret
  but the env var it names is unset or mismatched.
- **Payload arrives as a string, not an object** — the message wasn't valid JSON;
  `body.payload` is then the raw text. Publish JSON to get a structured object.

## License

Apache-2.0.
