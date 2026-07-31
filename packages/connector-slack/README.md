# Slack connector — `@nanobpm/nano-ide-connector-slack`

> Talk to Slack from your processes — **both directions**. Post messages from a
> BPMN service task (**outbound**), and start/feed processes from Slack events
> and slash commands (**inbound**). The first example **connector** proving the
> Urban I/O surface end to end.

This is a pack for the Nano / Urban RAD console. It is the reference
implementation for a **connector**: a single pack that contributes to *both*
edges of the I/O surface, unlike a plain `nano-ide-trigger-*` pack (inbound only)
or a component library (design-time only).

| Edge | What it contributes | Host surface | Status |
|---|---|---|---|
| **Outbound** | a **component** (element template `Send Slack Message`) + a **worker** that posts to Slack | `components[]` (ADR 0033, live) + `workers[]` (ADR 0050, host wiring pending) | template drives the palette today; worker launch is the ADR 0050 increment |
| **Inbound** | a **trigger source** (`slack`) + a Socket-Mode **driver** | `triggerSources[]` + supervised driver (ADR 0025 §6 phase 4, live) | works end to end today |

## The two edges

### Outbound — “Send Slack Message” (component + worker)

Drag **Send Slack Message** from the palette onto a service task. Its properties
panel (from `components/send-message.json`) exposes FEEL inputs — **Channel**,
**Message**, optional **Thread** — and a **Result variable** (`{ ts, channel }`).
The task's `zeebe:taskDefinition:type` is `slack:send-message`, the **seam** to
the runtime worker of the same type (`worker.ts`), which calls Slack
`chat.postMessage`.

The worker is a **long-lived job worker** (Zeebe-style): it subscribes by
`slack:send-message`, is started when the connector is enabled and the App runs,
and is supervised (restart-with-backoff, killed on stop) — the same lifecycle as
a trigger driver. Outbound at-least-once delivery is inherited from the engine's
durable **job queue** (the job *is* the outbox), so there is no separate durable
subsystem — the symmetric dual of the trigger **inbox**.

> **At-least-once caveat.** `chat.postMessage` is not idempotent; a job
> re-activated after a worker crash between "posted" and "completed" can post
> twice. Design for it, or thread a client de-dupe key (follow-up).

### Inbound — Slack events & slash commands (trigger source)

The `slack` trigger source opens a Slack **Socket Mode** connection (no public
URL required) and forwards each Events-API event / slash command to the trigger
ingress, where each can **start a process** or **correlate a message**
(ADR 0025). The runtime owns the durable inbox, dispatch, retry, and the driver's
lifecycle; the driver only *produces* events.

## Configuration (no secrets in the bundle)

Credentials are **env-pointers**, resolved at boot and never written into the
committed manifest (ADR 0027 §5):

| Field | Env | Scope | Used by |
|---|---|---|---|
| Bot token (`xoxb-…`, `chat:write`) | `SLACK_BOT_TOKEN` | connector | outbound worker |
| App-level token (`xapp-…`, `connections:write`) | `SLACK_APP_TOKEN` | connector | inbound driver |

Per-instance settings (which channel, the message text) live on the **element
template** (the properties panel); the shared token lives on the **connector**
(the project config surface). That split mirrors ADR 0025's "connection defined
once, referenced by instances".

## Slack app setup

1. Create a Slack app; enable **Socket Mode** and generate an app-level token
   (`connections:write`) → `SLACK_APP_TOKEN`.
2. Add the bot scope `chat:write`; install to the workspace; copy the bot token
   (`xoxb-…`) → `SLACK_BOT_TOKEN`.
3. Subscribe to the events you want (e.g. `app_mention`) and/or add slash
   commands. Set the trigger's **Event types** to filter (default `app_mention`).

## Files

| File | Role |
|---|---|
| `nano-ide.ext.json` | pack manifest: `triggerSources[]` (inbound) + `components[]` + `workers[]` (outbound) |
| `components/send-message.json` | element template (design-time face of the outbound component) |
| `worker.ts` | outbound worker (`@nanobpm/worker` `defineWorker`, type `slack:send-message`) |
| `driver.ts` | inbound Socket-Mode driver (emits to the trigger ingress) |
| `types/nanobpm-worker.d.ts` | compile-time contract for the host-provided `@nanobpm/worker` module |
| `connector.test.ts` | guards the design→runtime seam (template type ↔ worker type) |

## Develop

```bash
npm run typecheck   # tsc, no build (erasable TS)
npm test            # node --test — cross-artifact seam guards
node ../../scripts/validate-manifests.mjs   # manifest contract
```

See ADR 0033 (components), ADR 0025 (triggers), ADR 0027 (manifest/secrets), and
ADR 0050 (connectors / outbound workers / project-enablement).
