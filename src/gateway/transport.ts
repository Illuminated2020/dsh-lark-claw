/** Official Feishu Channel SDK adapter. The Gateway depends only on this file's port. */

import {
  createLarkChannel,
  Domain,
  type LarkChannel,
  type LarkChannelOptions,
  type NormalizedMessage,
  type SendOptions,
} from '@larksuiteoapi/node-sdk'
import type { FeishuMessage, FeishuResource, FeishuSendOptions, FeishuTarget, FeishuTransport, FeishuTransportConfig, FeishuTransportFactory } from './types.ts'

interface RawMessageResponse {
  readonly data?: {
    readonly message_id?: string
    readonly thread_id?: string
  }
}

function targetOptions(target: FeishuTarget, options?: FeishuSendOptions): SendOptions {
  return {
    ...target.threadId === undefined ? {} : { replyInThread: true },
    ...options?.replyTo === undefined ? {} : { replyTo: options.replyTo },
    ...options?.replyInThread === undefined ? {} : { replyInThread: options.replyInThread },
  }
}

function resourceOf(resource: NormalizedMessage['resources'][number]): FeishuResource | undefined {
  if (resource.type === 'sticker') return undefined
  return {
    type: resource.type,
    fileKey: resource.fileKey,
    ...resource.fileName === undefined ? {} : { fileName: resource.fileName },
  }
}

function normalizeMessage(message: NormalizedMessage): FeishuMessage {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    content: message.content,
    ...message.threadId === undefined ? {} : { threadId: message.threadId },
    ...message.rootId === undefined ? {} : { rootId: message.rootId },
    ...message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId },
    resources: message.resources.flatMap((resource) => {
      const normalized = resourceOf(resource)
      return normalized === undefined ? [] : [normalized]
    }),
    receivedAt: message.createTime,
  }
}

/** One official SDK Channel wrapped in the Gateway's provider-neutral port. */
export class LarkFeishuTransport implements FeishuTransport {
  readonly channelId: string

  constructor(channelId: string, private readonly channel: LarkChannel) {
    this.channelId = channelId
  }

  onMessage(handler: (message: FeishuMessage) => void | Promise<void>): () => void {
    return this.channel.on('message', message => handler(normalizeMessage(message)))
  }

  connect(): Promise<void> {
    return this.channel.connect()
  }

  disconnect(): Promise<void> {
    return this.channel.disconnect()
  }

  async sendCard(target: FeishuTarget, card: Readonly<Record<string, unknown>>, options?: FeishuSendOptions) {
    return this.sendRaw(target, 'interactive', JSON.stringify(card), options)
  }

  updateCard(messageId: string, card: Readonly<Record<string, unknown>>): Promise<void> {
    return this.channel.updateCard(messageId, { ...card })
  }

  async sendText(target: FeishuTarget, text: string, options?: FeishuSendOptions) {
    return this.sendRaw(target, 'text', JSON.stringify({ text }), options)
  }

  async sendImage(target: FeishuTarget, data: Uint8Array, _fileName: string, options?: FeishuSendOptions) {
    return this.channel.send(target.chatId, { image: { source: Buffer.from(data) } }, targetOptions(target, options))
  }

  async sendFile(target: FeishuTarget, data: Uint8Array, fileName: string, options?: FeishuSendOptions) {
    return this.channel.send(target.chatId, { file: { source: Buffer.from(data), fileName } }, targetOptions(target, options))
  }

  async uploadImage(data: Uint8Array, _fileName: string): Promise<string> {
    const response = await this.channel.rawClient.im.v1.image.create({
      data: { image_type: 'message', image: Buffer.from(data) },
    })
    const imageKey = response?.image_key
    if (imageKey === undefined) throw new Error('Feishu image upload did not return image_key')
    return imageKey
  }

  async downloadResource(fileKey: string, type: 'image' | 'file'): Promise<Uint8Array> {
    return this.channel.downloadResource(fileKey, type === 'image' ? 'image' : 'file')
  }

  /**
   * Use the raw message API for replies so Feishu returns the thread_id.
   * The high-level Channel.send() intentionally exposes only messageId; that
   * is enough for ordinary sends but cannot implement the gateway's durable
   * thread-to-session mapping.
   */
  private async sendRaw(
    target: FeishuTarget,
    msgType: 'interactive' | 'text',
    content: string,
    options?: FeishuSendOptions,
  ): Promise<{ messageId: string; threadId?: string }> {
    const replyInThread = options?.replyInThread ?? target.threadId !== undefined
    let response: RawMessageResponse
    if (options?.replyTo !== undefined) {
      response = await this.channel.rawClient.im.message.reply({
        path: { message_id: options.replyTo },
        data: {
          msg_type: msgType,
          content,
          reply_in_thread: replyInThread,
        },
      }) as RawMessageResponse
    } else {
      response = await this.channel.rawClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: target.chatId,
          msg_type: msgType,
          content,
        },
      }) as RawMessageResponse
    }
    const messageId = response.data?.message_id
    if (messageId === undefined) throw new Error('Feishu message response did not include message_id')
    return {
      messageId,
      ...response.data?.thread_id === undefined ? {} : { threadId: response.data.thread_id },
    }
  }
}

/** Factory backed by the Feishu-maintained Node SDK Channel module. */
export class LarkFeishuTransportFactory implements FeishuTransportFactory {
  create(config: FeishuTransportConfig): FeishuTransport {
    const options: LarkChannelOptions = {
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      transport: 'websocket',
      source: 'dsh-lark-claw-gateway',
      policy: {
        ...config.policy?.groupAllowlist === undefined ? {} : { groupAllowlist: [...config.policy.groupAllowlist] },
        ...config.policy?.dmMode === undefined ? {} : { dmMode: config.policy.dmMode },
        ...config.policy?.dmAllowlist === undefined ? {} : { dmAllowlist: [...config.policy.dmAllowlist] },
        ...config.policy?.requireMention === undefined ? {} : { requireMention: config.policy.requireMention },
      },
    }
    return new LarkFeishuTransport(config.channelId, createLarkChannel(options))
  }
}

/**
 * Create the official Feishu Channel transport factory.
 * @returns a factory that constructs WebSocket-backed Feishu transports.
 */
export function createLarkFeishuTransportFactory(): FeishuTransportFactory {
  return new LarkFeishuTransportFactory()
}
