description: "让 DeepSeek Harness 通过独立插件长期运行在飞书/Lark 中。"
kind: "package-library"

# dsh-lark-claw

[English](README.md) | 中文

让 DeepSeek Harness 通过飞书/Lark 接收消息、运行 Agent，并把结果发回会话。dsh-lark-claw 是一个独立的第三方 dsh 插件，不修改 dsh 核心仓库。

这个项目借用了 OpenClaw 的使用方式：Agent 长期运行在服务器上，用户从飞书发消息，Session、会话状态和定时任务由服务自己持久化。

## 这个插件做什么

- 通过官方 Lark Node SDK 的 WebSocket Channel 接收飞书消息。
- 按飞书会话和话题保存 Thread 到 dsh Session 的映射，服务重启后可以继续原来的会话。
- 用执行卡片展示运行中的文本、推理和工具步骤，卡片更新失败时降级为普通文本。
- 支持图片和文件输入。图片以 dsh image block 进入 Session，其他文件在 dsh Attachment store 可用时保存下来。
- 把 Agent 生成的文件，以及工作目录内 Markdown 链接指向的本地文件发回飞书。
- 用 dsh SQLite storage domain 持久化 Cron 任务。
- 提供一个适合单进程部署的 nohup 监督脚本。

插件通过普通 dsh Bundle 加载，包含一个 profile patch 和两个 Cordis 插件入口。dsh 核心源码不需要修改。

## 使用前准备

- Node.js 20 或更高版本。
- dsh 0.1.2-rc.1 或更高版本。
- 一个已经配置好机器人的飞书/Lark 应用，以及 App ID 和 App Secret。
- dsh 能使用的模型配置，例如 DEEPSEEK_API_KEY，以及你在 dsh 中使用的 provider 和 model 设置。

## 安装

安装 npm 包：

```bash
dsh plugin --profile feishu add dsh-lark-claw
```

也可以直接安装 GitHub 仓库：

```bash
dsh plugin --profile feishu add github:Illuminated2020/dsh-lark-claw
```

这里的 profile 仍然叫 feishu。它对应飞书运行配置，插件包本身的名称是 dsh-lark-claw。

## 配置

推荐把配置写入 `$DSH_HOME/config.yaml`，默认路径是 `~/.dsh/config.yaml`。可以复制 [`config.yaml.example`](config.yaml.example) 后修改；也可以通过 `DSH_LARK_CLAW_CONFIG` 指定另一份 YAML 文件。

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

`messaging.channels` 是飞书连接列表。`params.app_id`、`params.app_secret` 和 `params.chat_id` 分别是应用 ID、应用密钥和主动消息的默认会话；`app_secret` 也可以写成 `$FEISHU_MAIN_APP_SECRET`，让插件从环境变量读取密钥。`dm_allowlist` 和 `group_allowlist` 可以写 JSON 字符串，也可以写 YAML 字符串数组。

`agents.default.model` 和 `agents.default.provider` 会作为这个飞书网关创建 dsh Agent 时的模型选项。API Key 仍由 dsh 的凭据机制管理，推荐放在 `$DSH_HOME/.credentials.yaml`；现有 `$DSH_HOME/.env` 也继续兼容。YAML 文件没有配置的可选项使用插件默认值。

启动：

```bash
dsh --profile feishu
```

一个 YAML 文件可以配置多个飞书/Lark Channel。每个 Channel 使用以下字段：

| 字段 | 说明 |
| --- | --- |
| id | Channel 在本地的标识。 |
| `id` | Channel 在本地的标识。 |
| `type` | 填 `feishu` 或 `lark`。 |
| `params.app_id` | 飞书/Lark App ID。 |
| `params.app_secret` | App Secret 明文，或 `$ENV_NAME` 环境变量引用。 |
| `params.chat_id` | Cron 和主动消息使用的默认会话，可选。 |
| `params.thread_id` | 默认话题，可选。 |
| `params.dm_mode` | 私聊策略：allowlist、open、pair 或 disabled。 |
| `params.dm_allowlist` | 私聊白名单，填写用户的 open_id。 |
| `params.group_allowlist` | 群聊白名单。未填写或为空时接受群聊，填写后只接受列表中的群。 |
| `params.require_mention` | 群聊消息是否必须 @ 机器人。 |

`gateway.stream_update_interval_ms` 默认是 300，`gateway.card_markdown_limit` 默认是 28000。

`params.chat_id` 未配置时，只有当前飞书 Session 能提供目标的任务可以发送；独立 Cron 任务需要显式传入目标。

历史的 `FEISHU_*` 和 `DSH_FEISHU_*` 环境变量仍然兼容，但只在 `$DSH_HOME/config.yaml` 不存在时作为回退。

Cron 默认监听 `127.0.0.1:8787`，使用 `timezone` 或本机时区，并允许同时执行 4 个任务。需要远程管理 Cron 时，在 `server.host` 设置可访问的地址，并配置 `server.api_token` 或 `cron.api_token`。

## 消息和 Session

网关把飞书 Channel、话题和 dsh Session 连接起来：

```text
飞书消息
   │
   ▼
dsh-lark-claw Gateway ── 飞书话题 → dsh Session
   │                                  │
   ▼                                  ▼
执行卡片                         dsh Agent
```

- 已经属于飞书话题的消息，会继续使用这个话题对应的 Session。
- 没有话题的第一条消息会创建新 Session。第一次回复返回话题 ID 后，网关会保存这个 ID，后续消息就能回到同一个话题。
- 消息 ID 会写入持久化状态，已经接收过的消息不会在重启后自动重复执行。
- 同一个话题内的消息按顺序执行，/stop 可以停止当前 Turn。
- /reset 为当前话题创建新 Session，/status 查看 Session 和 Turn 状态，/help 查看命令。

Agent 运行时，网关会先发送一张执行卡片，再随着 dsh Session 事件更新文本、推理和工具步骤。Turn 结束后写入最终状态；卡片更新失败时会发送普通文本回复。

飞书图片会下载后保存为 dsh image block。其他媒体在当前 dsh 版本提供文件附件服务时会保存为文件附件。Agent 生成的文件和工作目录中引用的本地文件也会在 Turn 结束后发回飞书。

## 持久化 Cron

Cron 任务保存在 dsh 的 SQLite storage domain 中，默认文件位于 $DSH_HOME/storage/feishu-gateway.sqlite。服务重启后会重新加载任务，并通过正常的 dsh Agent、Session 和飞书执行卡片链路运行。

支持的调度方式：

- at：一次性任务。模型工具使用未来的 ISO 8601 时间，HTTP API 使用未来的 Unix 时间戳，单位是毫秒。
- delay：创建任务后延迟执行，单位是毫秒。
- every：按固定间隔重复执行，单位是毫秒。
- pattern：五字段 Cron 表达式，例如 0 9 * * 1-5。
- limit：限制重复任务的最大执行次数。

Agent 可以使用 cron_create、cron_list 和 cron_delete 三个工具。创建任务时可以沿用当前飞书 Session，也可以创建独立 Session。没有显式指定目标时，需要在 Channel 中配置 proactiveTarget。

管理 API 默认监听 127.0.0.1:8787：

```bash
curl http://127.0.0.1:8787/api/cronjobs
curl -X POST http://127.0.0.1:8787/api/cronjobs -H 'content-type: application/json' -d '{"instruction":"检查服务状态并把结果发到飞书","schedule":{"every":3600000}}'
curl -X PATCH http://127.0.0.1:8787/api/cronjobs/<id> -H 'content-type: application/json' -d '{"instruction":"再次检查服务状态"}'
curl -X DELETE http://127.0.0.1:8787/api/cronjobs/<id>
```

配置 FEISHU_CRON_API_TOKEN 后，HTTP 请求使用 Authorization: Bearer <token> 或 X-Feishu-Cron-Token: <token> 进行认证。当管理 API 监听 0.0.0.0 时，必须配置 token。

## 在云服务器上运行

仓库提供了一个适合单进程部署的启动脚本：

```bash
./scripts/dsh-lark-claw-service.sh start
./scripts/dsh-lark-claw-service.sh status
./scripts/dsh-lark-claw-service.sh logs
./scripts/dsh-lark-claw-service.sh restart
./scripts/dsh-lark-claw-service.sh stop
```

脚本用 nohup 启动 dsh --profile feishu，记录 PID 和日志，在停止时转发 TERM，并在 dsh 异常退出后自动重启。dsh 不在 PATH 中时，可以设置 DSH_BIN。监督器默认把状态放在 .dsh-lark-claw，也可以用 DSH_LARK_CLAW_SERVICE_ROOT 修改目录。

这个脚本只负责监督一个进程，不负责负载均衡、滚动发布和多实例健康检查。需要这些能力时，再接入 systemd、容器平台或其他进程管理器。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run
```

插件通过 peer dependencies 使用 dsh 的已发布接口，不需要依赖 dsh 源码仓库。

## 许可证

MIT
