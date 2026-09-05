# dsh-lark-claw

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1%2B-4d6bfe)](https://deepseek-harness.github.io/deepseek-harness/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) | 中文

**在飞书里使用 DeepSeek Harness，让机器人帮你处理任务。**

![飞书连接 DeepSeek Harness](assets/feishu-deepseek.png)

私聊或在群里 @ 机器人，就能让它查看项目、分析文件、安排提醒。执行过程实时显示在卡片中，你可以在同一话题里继续追问。

- **连续对话**：按话题保留上下文，服务重启后还能继续。
- **实时进度**：在飞书卡片中查看回答和工具执行过程。
- **图片和文件**：发送截图提问，或回复文件消息让机器人处理。
- **定时任务**：用自然语言设置一次性提醒或重复任务。

## 快速开始

准备好 dsh `0.1.2-rc.1` 或更高版本、Node.js `^22.19.0` 或 `>=24.0.0`、pnpm，以及一个飞书/Lark 应用。先确认 dsh 的模型和 API Key 已配置可用。

在飞书开放平台中完成以下设置：

- 启用机器人能力。
- 在“事件与回调”中选择“使用长连接接收事件”，并订阅 `im.message.receive_v1`。
- 开通机器人收发消息、读取消息和获取消息资源所需的应用身份权限。若要响应没有 @ 机器人的群消息，还需申请 `im:message.group_msg`。
- 发布应用或把测试用户加入可用范围；在群聊中使用时，还要把机器人加入群。

**安装插件：**

```sh
dsh plugin --profile feishu add dsh-lark-claw
```

`dsh plugin` 会调用 pnpm 管理 profile。npm 尚未发布所需版本时，请按[本地源码安装](guides/advanced.zh.md#从本地源码安装)操作。

**配置机器人：**

参考 [配置示例](config.yaml.example)，将所需字段填入 `~/.dsh/config.yaml`（设置了 `DSH_HOME` 时使用该目录）。已有配置时合并字段，不要直接覆盖。

- 填写应用的 App ID、App Secret。
- 设置允许使用机器人的用户和群聊。`ou_xxx` 是用户 open_id，`oc_xxx` 是群聊 chat_id；示例默认启用私聊 allowlist，保留占位值会拒绝所有私聊。
- 将工作目录改成你希望机器人处理文件的绝对路径，并填写可用的模型配置。

各字段含义见 [配置指南](guides/advanced.zh.md#配置)。

**启动：**

```sh
dsh --profile feishu
```

保持进程运行，私聊机器人或在允许的群聊中 @ 它，收到回复即可开始使用。

## 怎么用

### 处理任务

> @机器人 看一下这个项目，帮我整理运行步骤。

机器人会在卡片里展示进度。继续在同一话题中回复，可以接着处理刚才的任务；群聊默认需要 @ 机器人。

### 看图和分析文件

发送图片并提问即可，看图需要使用支持图片输入的模型。

文件需要单独发送时，先发文件，再使用飞书的“回复”功能回复那条文件消息，并 @ 机器人：

> @机器人 总结这个文件，列出需要我关注的内容。

文件能否解析取决于 Agent 可用的工具。

### 设置提醒

> @机器人 每个工作日上午九点提醒我检查项目进度。

也可以让它查看或删除已有提醒。定时任务会保留，但到点执行需要服务正在运行。

### 审批和回答问题

需要操作授权时，机器人会在同一话题里发送“允许本次／拒绝”卡片。需要你补充信息时，会显示选项或输入框，提交后继续任务。只有发起当前任务的人可以操作，等待默认十分钟。

使用前需在飞书应用中启用卡片交互回调，见 [交互配置](guides/advanced.zh.md#审批和用户提问)。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看帮助 |
| `/status` | 查看当前会话状态 |
| `/stop` | 停止当前任务 |
| `/reset` | 在当前话题中开始新会话 |

## 更多文档

- [配置、更新和后台运行](guides/advanced.zh.md)
- [定时任务 API](guides/advanced.zh.md#定时任务)
- [附件存储说明](guides/advanced.zh.md#文件和图片)
- [本地开发](guides/advanced.zh.md#开发)
- [发布维护](guides/releasing.zh.md)

## 许可证

[MIT](LICENSE)
