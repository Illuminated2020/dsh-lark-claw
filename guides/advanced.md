# Configuration and operations

[Back to README](../README.md) · [中文](advanced.zh.md)

## Install

Requirements:

- dsh `0.1.2-rc.1` or later
- Node.js `^22.19.0` or `>=24.0.0`
- pnpm, which `dsh plugin` invokes inside the profile directory
- A Lark/Feishu app with an App ID and App Secret
- A model credential and provider configuration accepted by dsh

Enable the bot capability in the developer console, select long-connection event delivery, and subscribe to `im.message.receive_v1`. Grant the app-identity permissions needed to receive, send, read, and download message resources. Receiving group messages without a bot mention also requires `im:message.group_msg`. Publish the app or add test users to its availability scope, and add the bot to every group where it will be used.

Install from the package registry:

```sh
dsh plugin --profile feishu add dsh-lark-claw
```

This command requires the selected version to exist on npm.

### Install from local source

To try an unpublished revision, check out a trusted commit, build it in the source directory, and install the local checkout into the profile:

```sh
git clone https://github.com/Illuminated2020/dsh-lark-claw.git
cd dsh-lark-claw
git checkout <commit-sha>
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile feishu add .
```

To update an installed package:

```sh
dsh plugin --profile feishu update dsh-lark-claw@latest
```

The local checkout already contains its built `lib/` output, so the profile installation needs no build-script permission. A direct `github:` spec triggers pnpm's git-dependency build policy, whose configuration varies by pnpm version, and is therefore not the recommended installation path here.

## Configure

For a new configuration, copy [`config.yaml.example`](../config.yaml.example) to `$DSH_HOME/config.yaml` (normally `~/.dsh/config.yaml`) and fill in your app details. If a configuration already exists, merge the required fields to preserve existing settings. Set `DSH_LARK_CLAW_CONFIG` when you want to use another path.

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

`app_secret` can be written as `$ENV_NAME`; the value is read from the environment. Alternatively, use `params.app_secret_env` and let dsh credentials resolve the reference. API keys stay in dsh's credential configuration.

| Setting | Meaning |
| --- | --- |
| `messaging.channels` | One or more Feishu/Lark connections. `type` is `feishu` or `lark`. |
| `params.chat_id` | Default destination for proactive and independent scheduled messages. |
| `params.thread_id` | Default topic for proactive messages. |
| `params.dm_mode` | `open`, `allowlist`, or `disabled`. The SDK currently treats the reserved `pair` value as `open`; do not use it for access control. |
| `params.dm_allowlist` | Sender open IDs accepted for direct messages. |
| `params.group_allowlist` | Group chat IDs. Empty means all groups. |
| `params.require_mention` | Require a bot mention in group messages. |
| `gateway.workspace` | Absolute workspace used by dsh Agents and upload storage. |
| `server.host` / `server.port` | Cron management API listener. Defaults to `127.0.0.1:8787`. |
| `cron.api_token` | Bearer token for the management API. Required when the server listens on `0.0.0.0`. |

Start the profile:

```sh
dsh --profile feishu
```

## Scheduled tasks

Create a task from the conversation with `cron_create`, or use the local API. These examples assume `CRON_API_TOKEN` matches the configured `cron.api_token`:

```sh
curl http://127.0.0.1:8787/api/cronjobs \
  -H "Authorization: Bearer $CRON_API_TOKEN"
curl -X POST http://127.0.0.1:8787/api/cronjobs \
  -H "Authorization: Bearer $CRON_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"instruction":"Check service health and report the result","schedule":{"every":3600000}}'
```

The model tool and HTTP API use different parameter names and time units. Select exactly one schedule per task:

| Schedule | `cron_create` tool | HTTP API `schedule` |
| --- | --- | --- |
| Specific time | `at`: future ISO 8601 string | `at`: future Unix timestamp in milliseconds |
| One-time delay | `after_seconds`: seconds | `delay`: milliseconds |
| Fixed interval | `every_seconds`: seconds | `every`: milliseconds |
| Cron expression | `pattern`: five-field expression | `pattern`: five-field expression |

For example, use `0 9 * * 1-5` for `pattern`. Recurring tasks may set `limit`.

Tasks created with the current Session continue that Session and reply to its stored card message. Independent tasks create a separate Session and establish their own Feishu topic. If a task has only a topic ID and no stored message anchor, the gateway queries the topic for an anchor; it fails instead of silently posting to the chat when the topic cannot be resolved.

## Files and images

To process a file sent separately in a group:

1. Send the file.
2. Use Lark/Feishu's reply action on that file message.
3. Mention the bot in your reply and include an instruction, such as “@bot Summarize this PDF”.

A separate “@bot Read the file above” message does not identify the attachment; explicitly reply to the original message. The gateway reads attachments after the triggering message passes access checks. It does not scan or download every file in the chat, and it follows only the directly replied message, not earlier replies. The bot needs permission to read that message and download its resources.

| Input | Storage and model input |
| --- | --- |
| Images, including images in rich-text messages | Saved in the dsh attachment store and passed as native image blocks; not automatically copied to `uploads/`. Image understanding requires a model that accepts image input and the dsh attachment service. |
| Files, audio and video | Saved under `<workspace>/uploads/` and passed as absolute paths for the Agent's tools to read. Format support depends on the available tools. |

Attachments in the current message and the directly replied message are included together. Duplicate names receive numeric suffixes (`report.pdf`, `report-1.pdf`, and so on). Uploads are not automatically deleted and remain available after a restart. Lookup, download or storage failures are included in the conversation alongside the user's text and any successful attachments.

`outputs/` is a possible convention for processed results; the gateway does not automatically move generated files there. Specify the output path or configure the Agent's workspace rules to use a consistent location.

## Run as a service

```sh
./scripts/dsh-lark-claw-service.sh start
./scripts/dsh-lark-claw-service.sh status
./scripts/dsh-lark-claw-service.sh logs
./scripts/dsh-lark-claw-service.sh restart
./scripts/dsh-lark-claw-service.sh stop
```

Run these commands from the source checkout or an extracted npm package root. The supervisor restarts a child after an unexpected exit and forwards `TERM` during shutdown. Set `DSH_BIN` when `dsh` is not on `PATH`, or `DSH_LARK_CLAW_SERVICE_ROOT` to choose another state directory.

After updating the plugin, restart the running `dsh --profile feishu` process. The `restart` command above only manages a service started by this script; stop and relaunch manually started processes separately. When loading local source changes, run `pnpm run build` before restarting.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run
```

The package builds against published dsh interfaces and does not require a dsh source checkout.

## Approvals and user questions

In the Feishu app's Events & Callbacks → Callback Configuration, select persistent-connection delivery and subscribe to the new `card.action.trigger` callback. Apply the configuration and restart the service after updating the plugin. Subscribing only to `im.message.receive_v1` receives chat messages but does not deliver card answers.

Operation approvals use a separate Allow once / Reject card showing the tool, reason and available original call arguments. If the specified call's arguments cannot be found, no approval prompt is offered. Grants apply only to that operation. The plugin does not override dsh's `never` approval policy, which rejects without prompting.

`ask_user_question` supports single and multiple selections plus custom text. Plan reviews show the complete plan and its original options. Submitting sends structured answers to the waiting tool. Cancel, task stop, service shutdown and timeout end the wait. Incomplete or invalid submissions refresh the card for correction. The standard dsh Agent preset provides the question tool; custom presets must retain the corresponding tool and service.

Cards appear in the execution card's topic and can be answered only by the user who started the current task, without another mention. Callbacks validate channel, chat, card ID and user ID. Duplicate and expired clicks cannot grant another approval. dsh records decisions through its approval audit or tool results, and settled cards show their final status. Even if a card update fails, its old buttons no longer work. Pending requests do not survive a restart.

Set `gateway.interaction_timeout_ms` to change the wait limit; the default is `600000` (ten minutes). Scheduled turns without a current initiating user do not create prompts that arbitrary chat members could approve. Without another answerer, dsh reports unavailable approval or a failed question according to its own rules.
