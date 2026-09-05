# dsh-lark-claw

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1%2B-4d6bfe)](https://deepseek-harness.github.io/deepseek-harness/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English | [中文](README.zh.md)

**Use DeepSeek Harness from Lark or Feishu and let your bot handle tasks.**

![Lark and Feishu connected to DeepSeek Harness](assets/feishu-deepseek.png)

Message the bot directly or mention it in a group to explore a project, analyze a file, or schedule a reminder. Follow progress in a live card and continue the conversation in the same topic.

- **Ongoing conversations**: Keep context per topic and continue after a service restart.
- **Live progress**: See responses and tool activity directly in chat.
- **Images and files**: Ask about a screenshot or reply to a file message to process it.
- **Scheduled tasks**: Set one-time reminders or recurring tasks in natural language.

## Quickstart

You need dsh `0.1.2-rc.1` or later, Node.js `^22.19.0` or `>=24.0.0`, pnpm, and a Lark/Feishu app. Make sure your model and API key already work in dsh.

Configure the app in the Lark/Feishu developer console:

- Enable the bot capability.
- Select long-connection event delivery and subscribe to `im.message.receive_v1`.
- Grant the app-identity permissions needed to receive, send, read, and download message resources. Responding to group messages without a bot mention also requires `im:message.group_msg`.
- Publish the app or add test users to its availability scope. Add the bot to each group where it will be used.

**Install the plugin:**

```sh
dsh plugin --profile feishu add dsh-lark-claw
```

`dsh plugin` uses pnpm to manage the profile. If the required version is not yet on npm, follow the [local source installation](guides/advanced.md#install-from-local-source) instructions.

**Configure your bot:**

Use the [example configuration](config.yaml.example) to fill in `~/.dsh/config.yaml` (or the directory set by `DSH_HOME`). Merge the required fields if you already have a configuration.

- Enter your app's App ID and App Secret.
- Set the users and groups allowed to use the bot. `ou_xxx` is a user open_id and `oc_xxx` is a chat_id. The example enables a direct-message allowlist, so leaving its placeholder rejects every direct message.
- Choose an absolute workspace path for the bot's files and configure an available model.

See the [configuration guide](guides/advanced.md#configure) for field descriptions.

**Start:**

```sh
dsh --profile feishu
```

Keep the process running. Send the bot a direct message or mention it in an allowed group; once it replies, you're ready.

## Usage

### Work on a task

> @bot Look through this project and explain how to run it.

The bot shows progress in a card. Reply in the same topic to continue working on the task. Group messages require a bot mention by default.

### Ask about images and files

Send an image with your question. Image understanding requires a model that accepts image input.

If a file must be sent separately, send it first, then use Lark/Feishu's reply action on that file message and mention the bot:

> @bot Summarize this file and highlight what needs my attention.

File format support depends on the Agent's available tools.

### Schedule a reminder

> @bot Remind me to check project progress at 9 a.m. every weekday.

You can also ask it to list or delete reminders. Scheduled tasks are saved, but the service must be running when they are due.

### Approvals and questions

When an operation needs permission, the bot posts an Allow once / Reject card in the same topic. Questions appear as choices or text fields; submitting an answer continues the task. Only the user who started the current task can respond. Requests expire after ten minutes by default.

Enable card interaction callbacks in your Feishu app first; see [interaction setup](guides/advanced.md#approvals-and-user-questions).

### Commands

| Command | Action |
| --- | --- |
| `/help` | Show help |
| `/status` | Check the current conversation's status |
| `/stop` | Stop the current task |
| `/reset` | Start a new conversation in the current topic |

## More documentation

- [Configuration, updates and background operation](guides/advanced.md)
- [Scheduled task API](guides/advanced.md#scheduled-tasks)
- [Attachment storage](guides/advanced.md#files-and-images)
- [Local development](guides/advanced.md#development)
- [Release maintenance](guides/releasing.md)

## License

[MIT](LICENSE)
