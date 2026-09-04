description: "Run DeepSeek Harness as a long-running Lark/Feishu agent through an independent dsh plugin."
kind: "package-library"

# dsh-lark-claw

English | [中文](README.zh.md)

Run DeepSeek Harness as a long-running Lark/Feishu agent. dsh-lark-claw is an independent third-party dsh plugin: it connects Lark/Feishu to the normal dsh Agent and Session APIs without changing the dsh core repository.

The name describes the intended shape of the project: a dsh-based agent you can reach from Lark/Feishu and keep running on a server, similar to the way people use OpenClaw.

## What it provides

- A WebSocket Feishu/Lark gateway backed by the official Lark Node SDK.
- Durable Thread-to-Session routing. A Feishu topic keeps using the same dsh Session after a restart.
- Streaming Execution Cards with tool steps, final status, and text fallback when a card update fails.
- Image and file input. Images enter dsh as image blocks; supported dsh attachment stores keep other files available to the Session.
- File delivery for files produced by the Agent and local files linked from the configured workspace.
- Persistent cron jobs backed by the dsh SQLite storage domain.
- A small nohup supervisor for one long-running process.

The plugin is a normal dsh Bundle. It contributes a startup profile and two Cordis plugin entries; it does not patch or vendor dsh source code.

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`.
- dsh 0.1.2-rc.1 or later.
- A Lark/Feishu app with its App ID and App Secret.
- A model configuration accepted by dsh, such as DEEPSEEK_API_KEY and the provider/model settings used by your dsh installation.

## Install

Install the published package:

```bash
dsh plugin --profile feishu add dsh-lark-claw
```

Or install the GitHub repository directly:

```bash
dsh plugin --profile feishu add github:Illuminated2020/dsh-lark-claw
```

The feishu profile name is intentional. It keeps the runtime command and existing Feishu configuration easy to recognize; the installable package is named dsh-lark-claw.

## Configure

The recommended configuration file is `$DSH_HOME/config.yaml`, normally `~/.dsh/config.yaml`. Copy [`config.yaml.example`](config.yaml.example) and edit it, or set `DSH_LARK_CLAW_CONFIG` to another YAML path.

```yaml
timezone: Asia/Shanghai

agents:
  default:
    type: dsh
    provider: deepseek
    model: deepseek-chat

messaging:
  default_channel_id: main
  channels:
    - id: main
      type: feishu
      params:
        app_id: cli_xxx
        app_secret: replace-me
        chat_id: oc_xxx
        dm_mode: allowlist
        dm_allowlist: '["ou_xxx"]'
        group_allowlist: '["oc_xxx"]'
        require_mention: true

gateway:
  workspace: /srv/dsh/workspace

server:
  host: 127.0.0.1
  port: 8787

cron:
  concurrency: 4
  api_token: replace-me
```

`messaging.channels` is the Feishu channel list. `params.app_id`, `params.app_secret`, and `params.chat_id` are the app ID, app secret, and default destination for proactive messages; `app_secret` can also be `$FEISHU_MAIN_APP_SECRET` to read the secret from the environment. `dm_allowlist` and `group_allowlist` accept either JSON strings or YAML string arrays.

`agents.default.model` and `agents.default.provider` become the model options used when this gateway creates a dsh Agent. API keys remain under dsh's credential mechanism; `$DSH_HOME/.credentials.yaml` is recommended, and an existing `$DSH_HOME/.env` remains compatible. Optional values absent from YAML use the plugin defaults.

Start dsh with the profile:

```bash
dsh --profile feishu
```

One YAML file can serve more than one Lark/Feishu app. Each channel has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Local identifier for the channel. |
| `type` | `feishu` or `lark`; selects the corresponding official API domain. |
| `params.app_id` | Lark/Feishu App ID. |
| `params.app_secret` | App Secret, either literal or `$ENV_NAME`. |
| `params.chat_id` | Default destination for cron and proactive messages, optional. |
| `params.thread_id` | Default topic, optional. |
| `params.dm_mode` | Direct-message policy: allowlist, open, pair, or disabled. |
| `params.dm_allowlist` | Sender open IDs allowed by the direct-message allowlist. |
| `params.group_allowlist` | Group chat IDs. An omitted or empty list accepts groups; a non-empty list restricts messages to those groups. |
| `params.require_mention` | Whether a group message must mention the bot. |

`gateway.stream_update_interval_ms` defaults to 300, and `gateway.card_markdown_limit` defaults to 28000.

Without `params.chat_id`, an independent Cron task needs an explicit target; messages associated with a current Feishu Session still work normally.

The older `FEISHU_*` and `DSH_FEISHU_*` environment names remain accepted, but only as a fallback when `$DSH_HOME/config.yaml` is absent.

Cron listens on `127.0.0.1:8787`, uses `timezone` or the local timezone, and runs up to four jobs concurrently by default. For remote management, set an accessible `server.host` and configure `server.api_token` or `cron.api_token`.

## Messages, Sessions, and cards

The gateway keeps routing state in SQLite and uses the Feishu channel and topic IDs as the external route:

```text
Lark/Feishu message
        |
        v
dsh-lark-claw gateway ---- Thread to Session mapping
        |                                  |
        v                                  v
Execution Card                         dsh Agent
```

- A message that already belongs to a Feishu topic resumes the Session stored for that topic.
- A first message without a topic gets a new Session. The topic ID returned by the first reply is stored for later messages.
- Message IDs are recorded for idempotency. A delivery that was already admitted is not replayed automatically after a process restart.
- Messages in the same topic are processed in order. /stop can interrupt a running turn.
- /reset creates a new Session for the current topic. /status shows the current Session and turn state. /help lists the commands.

While the Agent is running, the gateway sends an Execution Card and updates it with streamed text, reasoning, and tool steps. It writes the final status when the turn settles. If the card cannot be updated, it sends the bounded result as a normal text reply.

Images are downloaded from Feishu and admitted as dsh image blocks. Other media uses the dsh file attachment service when that service is available. The gateway also sends files produced by the Agent and local files linked from the configured workspace.

## Persistent cron

The cron plugin stores job definitions in the same dsh SQLite storage domain. Jobs load again after a restart and run through the normal dsh Agent, Session, and Feishu card path.

Supported schedules are:

- at: one future ISO 8601 timestamp through the model tool, or a future Unix timestamp in milliseconds through the HTTP API.
- delay: one delay in milliseconds through the HTTP API.
- every: a recurring interval in milliseconds through the HTTP API.
- pattern: a five-field cron expression such as 0 9 * * 1-5.
- limit: an optional maximum number of recurring runs.

The model has three tools: cron_create, cron_list, and cron_delete. A job can reuse the current Feishu Session or run in a new Session. For a job created without an explicit target, configure `params.chat_id` on the channel.

The management API listens on 127.0.0.1:8787 by default:

```bash
curl http://127.0.0.1:8787/api/cronjobs
curl -X POST http://127.0.0.1:8787/api/cronjobs -H 'content-type: application/json' -d '{"instruction":"Check service health and report the result to Feishu","schedule":{"every":3600000}}'
curl -X PATCH http://127.0.0.1:8787/api/cronjobs/<id> -H 'content-type: application/json' -d '{"instruction":"Check service health again"}'
curl -X DELETE http://127.0.0.1:8787/api/cronjobs/<id>
```

If FEISHU_CRON_API_TOKEN is set, send it with Authorization: Bearer <token> or X-Feishu-Cron-Token: <token>. A token is required when the control server listens on 0.0.0.0.

## Run on a server

The repository includes a portable supervisor for one dsh process:

```bash
./scripts/dsh-lark-claw-service.sh start
./scripts/dsh-lark-claw-service.sh status
./scripts/dsh-lark-claw-service.sh logs
./scripts/dsh-lark-claw-service.sh restart
./scripts/dsh-lark-claw-service.sh stop
```

The script starts dsh --profile feishu with nohup, records a PID, writes logs, forwards TERM for graceful shutdown, and restarts the child after an unexpected exit. Set DSH_BIN if dsh is not on PATH. The default supervisor state directory is .dsh-lark-claw; set DSH_LARK_CLAW_SERVICE_ROOT to choose another location.

This script supervises one process. It does not provide load balancing, rolling deployment, or process health checks beyond checking the child process. Use a service manager or container platform when those features are needed.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run
```

The package declares dsh modules as peer dependencies and builds against their published interfaces. It does not require a checkout of the dsh source repository.

## License

MIT
