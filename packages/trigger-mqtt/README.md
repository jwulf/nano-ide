# @nanobpm/nano-ide-trigger-mqtt

An **MQTT trigger source** for the Nano / Urban RAD console. Install it and any
App can react to MQTT messages: a broker topic becomes the *"when X…"* half of a
Zapier-style automation, with the message driving a process instance or
correlating a message into a running one (ADR 0025).

This is the `nano-ide-trigger-*` marketplace axis — the pack contributes the
`mqtt` source **kind** and ships an out-of-process **driver** that the runtime
auto-launches and supervises. The pack never touches the engine; it only
produces events over the trigger ingress, and the runtime owns the durable
inbox, dispatch, retry, and lifecycle.

## Install

Install it into your Urban workspace's extensions the same way as any other
pack (e.g. `c8ctl load plugin @nanobpm/nano-ide-trigger-mqtt`, or drop it under
`<workspace>/extensions`). Once installed, `mqtt` appears as a recognised source
kind in the console Triggers panel.

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

Each received message is delivered to the App as the event body:

```json
{ "topic": "home/kitchen/temperature", "payload": { "value": 21.4 }, "ts": "2026-07-24T00:00:00.000Z" }
```

- `topic` — the concrete topic the message arrived on (wildcards resolved).
- `payload` — the message payload parsed as JSON when possible, else the raw
  UTF-8 string.
- `ts` — ISO-8601 receive time.

Reference these in the action's FEEL (`variables` / `correlationKey`).

## Configuration

| field | required | default | notes |
| --- | --- | --- | --- |
| `url` | yes* | `mqtt://localhost:1883` | Broker URL: `mqtt://`, `mqtts://`, `ws://`, `wss://`. A `connection.url` overrides it. |
| `topics` | yes | — | Comma-separated topic filters. MQTT wildcards `+` (single level) and `#` (multi level) are allowed, e.g. `home/+/temperature`, `sensors/#`. |
| `qos` | no | `1` | Subscription QoS: `0`, `1`, or `2`. |

Credentials belong in a `connections[]` entry (referenced by the trigger's
`connection`), never inline in `config` — secrets should be env templates
(`{{ env.VAR }}`) the host resolves. The connection may supply `url`,
`username`, `password`, and `clientId`.

## How it runs

The runtime launches `driver.ts` (Node ≥22.6 with `--experimental-strip-types`,
or Deno) with the trigger's context in the environment
(`NANOBPMN_HOOK_URL`, `NANOBPMN_TRIGGER_CONFIG`, `NANOBPMN_TRIGGER_CONNECTION`,
`NANOBPMN_WEBHOOK_TOKEN`, …). The driver subscribes and POSTs each message to
the ingress with a stable idempotency key, so a retried delivery is collapsed
rather than double-processed. On crash it is restarted with backoff; on App stop
it is terminated (SIGTERM → clean disconnect).

## License

Apache-2.0.
