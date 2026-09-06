# 架构与维护

## Topic roots and scheduled delivery

`FeishuThreadRecord.topicRootMessageId` stores a stable conversation root independently of the latest reply anchor `cardMessageId`. It survives turns, restart and `/reset`, and is cleared when the route moves to a different topic. A continuation skips parent attachment lookup only when root and parent match the known root in the same channel, chat and thread. Non-root replies and unknown topics still use attachment lookup; current-message attachments are always admitted.

The optional field accepts old records. Before creating a route for an inbound message, the gateway checks for a matching durable channel/chat/thread record with an existing card or previously admitted message. For such a legacy conversation without a saved root, Feishu's `rootId === replyToMessageId` identifies the conversation root; the gateway saves it before running the turn. This works even when a previous answer replaced the root card anchor, or an old reset removed it. A route created for the current message cannot qualify. Once a root is stored, a different root is not silently adopted. The SDK does not distinguish ordinary continuation from explicitly quoting that same established root; both follow the existing known-topic continuation policy.

Scheduled turns ask the model to return the result as its final response for gateway delivery, without using lark-cli or other messaging tools to send it again or redirect it. This is a model instruction, not tool isolation. An unreachable destination remains a delivery error.

dsh-lark-claw 是独立的 DeepSeek Harness Bundle，通过 Cordis 将飞书/Lark 接入 dsh Agent，无需修改宿主源码。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/config/index.ts` | 解析 YAML、环境变量和渠道配置。 |
| `src/gateway/transport.ts` | 封装官方 SDK，收发消息、解析回复锚点和传输资源。 |
| `src/gateway/index.ts` | 授权、去重、话题路由、串行执行、Agent 创建与恢复、执行状态投射。 |
| `src/gateway/state.ts` | 持久化渠道、话题映射和消息处理记录。 |
| `src/gateway/message-resources.ts` | 文件落盘、重名处理和可读取的绝对路径提示。 |
| `src/gateway/card.ts` | 执行卡片渲染、长度限制和分块。 |
| `src/cron/index.ts` | 持久化计划、定时执行、模型工具与管理 API。 |
| `cordis.patch.yml` | 组合配置、SQLite、控制服务、Gateway 与 Cron。 |

## 执行流程

飞书 WebSocket 消息经过 Transport 标准化，由 Gateway 授权和去重后路由到 Session。Gateway 通过 `ctx.agents.create/resume` 和 `agent.followup/whenIdle` 执行，监听 Session 事件更新飞书卡片。Cron 通过相同的 Gateway 路径执行计划。

同话题消息串行执行，停止命令可以中断当前回合。话题映射持久化，重启后恢复会话；已接收消息不自动重放，避免重复外部操作。卡片更新失败时尝试文本回复。

话题 ID 与消息 ID 分开处理。已有会话优先回复持久化卡片；仅配置话题时查询历史获取消息锚点。无法定位时返回错误，不退回群聊。独立会话先发卡片，再回复继续对话提示，取得话题 ID 后绑定 Session。

## 文件输入

接收附件时，通过原消息 ID 和资源 key 调用 `im.v1.messageResource.get`，适用于图片消息及富文本消息中的图片。图片使用 dsh 原生 image block。普通文件、音频和视频保存在 `<workspace>/uploads`，通过绝对路径交给 Agent；具体格式能否解析取决于可用工具。上传文件持续保留，便于恢复会话后读取，插件不自动删除历史上传。

单个附件下载或保存失败时，原文、失败说明和其他成功附件仍进入同一条 dsh 用户消息，由 Session 记录，供当前及后续回合解释。失败附件不会生成 image block 或文件路径；网关不会重放整个消息。

重名文件依次写入 `report.pdf`、`report-1.pdf`，使用排他创建避免并发覆盖。外部文件名中的目录部分不参与保存路径构造。

## 开发边界

通过公开的 Cordis 服务使用宿主的 Agent、Session、tools、credentials 和 storageDomain，不重复实现模型执行内核。项目只依赖自身源码和包管理器安装的依赖，无需相邻源码检出。

`agents.default.type` 和 `tasking.max_retries` 当前仅被兼容解析，不用于切换执行器或配置任务重试。

按声明的 Node.js 和 pnpm 版本执行 `pnpm install`、`pnpm run typecheck`、`pnpm test`、`pnpm run lint`、`pnpm run build`。真实飞书联调需要应用权限和凭据。

用户可先发送文件，再回复该文件消息并 @ 机器人。触发消息通过原有 SDK 策略与网关授权检查后，网关使用 `replyToMessageId` 查询原消息，验证消息 ID、聊天 ID 和未删除状态，复用 SDK 解析附件。飞书话题内的普通续聊也可能把话题根消息写入 `parent_id`；当网关已经接收过该根消息时，不会把它再次当成显式回复或重复读取附件。下载使用原消息 ID；原消息附件与本次指令、本次自带附件一起交给 Agent。只读取直接回复的消息，不扫描聊天历史、不追溯回复链。查询失败说明进入会话；图片沿用原生 image block，其他文件保存到工作区 `uploads/`。

## 人工交互

`gateway/interactions.ts` 为用户发起的当前 Turn 注册 Agent 匹配的 `approval/request` 和 `user-questions/request` 应答器，其他 Agent 请求交给 `next()`。回调直接结算等待 Promise，不进入话题的普通消息队列。每个请求使用随机 ID，绑定渠道、聊天、独立交互卡片及发起人；过期、取消和已结算请求立即从内存删除。结束 Turn 时移除应答器，关闭网关时先取消交互再排空任务。定时 Turn 没有当前发起人，不注册飞书应答器。

Transport 开启 SDK 原始事件以读取 `action.form_value`，不将原始回调写入模型会话。表单选项值按原问题映射并验证。SDK 的动作去重不包含表单值，因此无效提交会刷新请求 ID，允许修正后重新提交；旧 ID 随即失效。审批与提问结果通过 dsh 服务返回，保留宿主审计和工具结果语义。

## 执行过程刷新

网关同时支持新版 `agent/assistant-stream` 临时帧和旧版 `session/event` 的 `assistant/chunk`。收到新版帧后不再消费旧版 chunk，避免重复。每次模型请求开始、结束时清理临时文本、思考和工具参数；已提交的 `assistant/message`、`tool/call`、`tool/result` 从 Session 历史重建步骤。工具执行期间也触发刷新，不等待 Turn 结束。

卡片按 `stream_update_interval_ms` 合并更新并串行发送；最终卡片等待已排队更新完成，随后移除监听和定时器。临时卡片更新失败记录日志，后续更新和最终回复继续尝试。
