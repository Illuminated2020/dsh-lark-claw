# 配置与运维指南

[返回首页](../README.zh.md) · [English](advanced.md)

## 安装

使用前需要：

- dsh `0.1.2-rc.1` 或更高版本
- Node.js `^22.19.0` 或 `>=24.0.0`
- 一个已经配置好的飞书/Lark 应用，以及 App ID 和 App Secret
- dsh 支持的模型凭据、provider 和 model 配置

从包管理器安装：

```sh
dsh plugin --profile feishu add dsh-lark-claw
```

也可以直接安装 GitHub 仓库：

```sh
dsh plugin --profile feishu add github:Illuminated2020/dsh-lark-claw
```

更新已安装的插件：

```sh
dsh plugin --profile feishu update dsh-lark-claw@latest
```

从 GitHub 安装时，pnpm 可能会要求允许插件的构建脚本。确认包内容后，在 `$DSH_HOME/profiles/feishu` 中执行 pnpm 输出的准确 `pnpm approve-builds` 命令，再重新安装。

## 配置

首次配置时，把 [`config.yaml.example`](../config.yaml.example) 复制到 `$DSH_HOME/config.yaml`（默认是 `~/.dsh/config.yaml`），再填入应用信息。已有配置时合并所需字段，避免覆盖原有设置。需要使用其他路径时设置 `DSH_LARK_CLAW_CONFIG`。

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

`app_secret` 可以写成 `$ENV_NAME`，插件会从环境变量读取；也可以使用 `params.app_secret_env`，由 dsh 凭据服务解析。API Key 仍然放在 dsh 的凭据配置中。

| 配置 | 说明 |
| --- | --- |
| `messaging.channels` | 一个或多个飞书/Lark 连接，`type` 填 `feishu` 或 `lark`。 |
| `params.chat_id` | 主动消息和独立定时任务的默认目标。 |
| `params.thread_id` | 主动消息的默认话题。 |
| `params.dm_mode` | `open`、`allowlist`、`pair` 或 `disabled`。 |
| `params.dm_allowlist` | 允许私聊的用户 open_id。 |
| `params.group_allowlist` | 允许的群聊 ID；为空时接受所有群聊。 |
| `params.require_mention` | 是否要求群聊消息 @ 机器人。 |
| `gateway.workspace` | dsh Agent 使用的绝对工作目录，也是上传文件目录的根。 |
| `server.host` / `server.port` | Cron 管理 API 监听地址，默认 `127.0.0.1:8787`。 |
| `cron.api_token` | 管理 API 的 Bearer token；监听 `0.0.0.0` 时必须配置。 |

启动 profile：

```sh
dsh --profile feishu
```

## 定时任务

可以让 Agent 使用 `cron_create` 创建任务，也可以调用本地 API。以下示例假设环境变量 `CRON_API_TOKEN` 与配置中的 `cron.api_token` 一致：

```sh
curl http://127.0.0.1:8787/api/cronjobs \
  -H "Authorization: Bearer $CRON_API_TOKEN"
curl -X POST http://127.0.0.1:8787/api/cronjobs \
  -H "Authorization: Bearer $CRON_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"instruction":"检查服务状态并报告结果","schedule":{"every":3600000}}'
```

模型工具和 HTTP API 使用不同的参数名与时间单位，每次只选一种调度方式：

| 调度 | `cron_create` 工具 | HTTP API 的 `schedule` |
| --- | --- | --- |
| 指定时间 | `at`：未来的 ISO 8601 时间字符串 | `at`：未来的 Unix 时间戳，毫秒 |
| 延迟一次 | `after_seconds`：秒 | `delay`：毫秒 |
| 固定间隔 | `every_seconds`：秒 | `every`：毫秒 |
| Cron 表达式 | `pattern`：五字段表达式 | `pattern`：五字段表达式 |

例如 `pattern` 可填 `0 9 * * 1-5`；重复任务可设置 `limit`。

使用当前 Session 创建的任务会继续该 Session，并回复已保存的卡片消息。独立任务会创建单独的 Session，并建立自己的飞书话题。只有话题 ID、没有已保存消息锚点时，网关才会查询话题消息来定位回复目标；话题无法解析时会报错，不会静默发到群聊。

## 文件和图片

在群聊中处理单独发送的文件：

1. 发送文件。
2. 使用飞书的“回复”功能，回复那条文件消息。
3. 在回复中 @ 机器人并写明指令，例如“@机器人 总结这个 PDF”。

单独再发一条“@机器人 看上面的文件”不会关联到该文件，必须明确回复原消息。网关在触发消息通过访问检查后读取附件；不会主动扫描和下载群里的所有文件。它只读取直接回复的那条消息，不追溯回复链。机器人需要有读取该消息和下载附件的权限。

| 输入 | 保存和使用方式 |
| --- | --- |
| 图片，包括富文本消息中的图片 | 存入 dsh 附件存储，通过原生 image block 交给模型；不会自动复制到 `uploads/`。看图需要支持图片输入的模型和 dsh 附件服务。 |
| 普通文件、音频、视频 | 保存到 `<workspace>/uploads/`，把绝对路径交给 Agent，再由工具读取；能否解析取决于可用工具。 |

本次消息自带的附件与被回复消息中的附件会一起交给 Agent。重名文件自动加数字后缀，例如 `report.pdf`、`report-1.pdf`；历史上传不会自动清理，重启后仍保留。附件查询、下载或保存失败时，失败原因与原文、其他成功附件一起进入会话。

`outputs/` 是处理结果可以使用的目录约定，网关不会自动把生成的文件移进去。需要统一存放位置时，应明确指定输出路径或配置 Agent 的工作区规则。

## 作为服务运行

```sh
./scripts/dsh-lark-claw-service.sh start
./scripts/dsh-lark-claw-service.sh status
./scripts/dsh-lark-claw-service.sh logs
./scripts/dsh-lark-claw-service.sh restart
./scripts/dsh-lark-claw-service.sh stop
```

监督脚本会在子进程异常退出后重启，并在停止时转发 `TERM`。`dsh` 不在 `PATH` 时设置 `DSH_BIN`；需要修改状态目录时设置 `DSH_LARK_CLAW_SERVICE_ROOT`。

更新插件后需重启实际运行的 `dsh --profile feishu` 进程。以上 `restart` 只管理由该脚本启动的服务；手动启动的进程需自行停止后重新启动。从本地源码加载时，先执行 `pnpm run build`，再重启。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm pack --dry-run
```

项目基于已发布的 dsh 接口构建，不需要 dsh 源码仓库。
