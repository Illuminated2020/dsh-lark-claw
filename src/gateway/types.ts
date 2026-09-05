/** Provider-neutral seams between the Feishu Gateway and a Feishu transport. */

import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One resource normalized by the Feishu transport. */
export interface FeishuResource {
  readonly type: 'image' | 'file' | 'audio' | 'video'
  readonly fileKey: string
  readonly fileName?: string | undefined
}

/** One inbound Feishu Conversation Thread message. */
export interface FeishuMessage {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId: string
  readonly content: string
  /** Feishu topic/thread id when present. */
  readonly threadId?: string | undefined
  readonly rootId?: string | undefined
  readonly replyToMessageId?: string | undefined
  readonly resources: readonly FeishuResource[]
  readonly receivedAt: number
}

/** Target for a reply or proactive message. */
export interface FeishuTarget {
  readonly chatId: string
  readonly threadId?: string
}

/** One scheduled turn requested by an external scheduler plugin. */
export interface FeishuScheduledTaskRequest {
  readonly schedulerId: string
  readonly instruction: string
  readonly sessionId: SessionId | null
  readonly channelId?: string
  readonly target?: FeishuTarget
  /** Human-readable schedule text included in the model-visible framing. */
  readonly scheduleDescription?: string
}

/** Receipt returned after a scheduled turn has settled and its card was sent. */
export interface FeishuScheduledTaskResult {
  readonly sessionId: SessionId
  readonly messageId?: string
  readonly threadId?: string
}

/** Stable provider service consumed by scheduler and future Feishu plugins. */
export interface FeishuGatewayService {
  resolveTarget(channelId?: string, target?: FeishuTarget): { channelId: string; target: FeishuTarget }
  resolveSessionTarget(sessionId: SessionId): { channelId: string; target: FeishuTarget } | undefined
  sendProactive(text: string, target?: FeishuTarget): Promise<void>
  runScheduledTask(request: FeishuScheduledTaskRequest): Promise<FeishuScheduledTaskResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishuGateway: FeishuGatewayService
  }
}

/** Options retained at the transport boundary so the Gateway stays SDK-neutral. */
export interface FeishuSendOptions {
  readonly replyTo?: string
  readonly replyInThread?: boolean
}

/** The minimum receipt needed to correlate an external card with Gateway State. */
export interface FeishuSendReceipt {
  readonly messageId: string
  /** Thread id returned by Feishu for a reply message, when available. */
  readonly threadId?: string
}

/** Verified SDK callback envelope; form fields remain untrusted until decoded. */
export interface FeishuCardAction {
  readonly messageId: string
  readonly chatId: string
  readonly userId: string
  readonly value: unknown
  readonly formValue?: unknown
}

/** Provider-neutral transport adapter; production and tests implement this seam. */
export interface FeishuTransport {
  readonly channelId: string
  onCardAction(handler: (action: FeishuCardAction) => void): () => void
  onMessage(handler: (message: FeishuMessage) => void | Promise<void>): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
  sendCard(target: FeishuTarget, card: Readonly<Record<string, unknown>>, options?: FeishuSendOptions): Promise<FeishuSendReceipt>
  updateCard(messageId: string, card: Readonly<Record<string, unknown>>): Promise<void>
  sendText(target: FeishuTarget, text: string, options?: FeishuSendOptions): Promise<FeishuSendReceipt>
  sendImage(target: FeishuTarget, data: Uint8Array, fileName: string, options?: FeishuSendOptions): Promise<FeishuSendReceipt>
  sendFile(target: FeishuTarget, data: Uint8Array, fileName: string, options?: FeishuSendOptions): Promise<FeishuSendReceipt>
  /** Upload an image for embedding in an interactive card. */
  uploadImage?(data: Uint8Array, fileName: string): Promise<string>
  /** Read attachments from one explicitly replied message in the same chat. */
  getMessageResources(messageId: string, chatId: string): Promise<readonly FeishuResource[]>
  /** Download a received resource using its source message, including post images. */
  downloadResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<Uint8Array>
}

/** Settings needed to construct one transport instance. */
export interface FeishuTransportConfig {
  readonly channelId: string
  readonly appId: string
  readonly appSecret: string
  readonly domain?: 'feishu' | 'lark'
  readonly policy?: {
    readonly groupAllowlist?: readonly string[]
    readonly dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled'
    readonly dmAllowlist?: readonly string[]
    readonly requireMention?: boolean
  }
}

/** Injectable constructor for a production or fake transport. */
export interface FeishuTransportFactory {
  create(config: FeishuTransportConfig): FeishuTransport
}

/** One configured source allowlist and target for a Feishu Channel. */
export interface FeishuChannelConfig {
  readonly id: string
  readonly appId: string
  /** Official API domain selected by the YAML channel type. */
  readonly domain?: 'feishu' | 'lark'
  /** Credential variable name used by the legacy environment configuration. */
  readonly appSecretEnv?: string
  /** Secret loaded from the plugin YAML configuration. */
  readonly appSecret?: string
  readonly groupAllowlist?: string[]
  readonly dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled'
  readonly dmAllowlist?: string[]
  readonly requireMention?: boolean
  readonly proactiveTarget?: FeishuTarget
}

/** Configuration of the Gateway Service Instance. */
export interface FeishuGatewayConfig {
  /** One fixed, absolute Workspace for all Feishu sessions in this instance. */
  readonly workspace: string
  /** Agent model options are optional; the composed default-model service fills them. */
  readonly provider?: string
  readonly model?: string
  channels: FeishuChannelConfig[]
  readonly defaultChannelId?: string
  /** Minimum interval between live card patches; 0 flushes every observed frame. */
  readonly streamUpdateIntervalMs?: number
  /** Maximum human response wait in milliseconds; defaults to ten minutes. */
  readonly interactionTimeoutMs?: number
  /** Maximum card markdown body before the pure card projection bounds it. */
  readonly cardMarkdownLimit?: number
}

/** File attachment shape supported by newer dsh attachment providers. */
export interface FeishuFileAttachment {
  readonly name?: string
  readonly [key: string]: unknown
}

/** Optional outbound file block from an attachment provider; inbound files use workspace paths. */
export interface FeishuFileBlock {
  readonly type: 'file'
  readonly attachment: FeishuFileAttachment
}

/** Session-facing attachment blocks admitted by dsh's attachment service. */
export type FeishuAttachmentBlock = ImageBlock | FeishuFileBlock

/** The card projection status owned by the Gateway, independent of Feishu JSON. */
export type ExecutionCardStatus = 'running' | 'completed' | 'cancelled' | 'error'

/** One compact, collapsible step in an Execution Card. */
export interface ExecutionCardStep {
  readonly label: string
  readonly status: 'running' | 'completed' | 'error'
  /** Feishu standard icon used by the card renderer. */
  readonly icon?: string
}

/** Provider-neutral Execution Card projection. */
export interface ExecutionCardProjection {
  readonly title: string
  readonly status: ExecutionCardStatus
  readonly markdown: string
  readonly thinking?: string
  readonly steps: readonly ExecutionCardStep[]
}

/** Durable Gateway State for one Thread → Session route. */
export interface FeishuThreadRecord {
  readonly channelId: string
  readonly threadId: string
  readonly chatId: string
  readonly sessionId: SessionId
  readonly workspace: string
  readonly cardMessageId?: string | undefined
  readonly updatedAt: number
}

/** Durable idempotency record for one inbound Feishu message. */
export interface FeishuMessageRecord {
  readonly channelId: string
  readonly messageId: string
  readonly threadKey: string
  readonly sessionId: SessionId
  readonly state: 'processing' | 'completed' | 'rejected'
  readonly updatedAt: number
}

/** Durable channel registration facts; secrets never enter this record. */
export interface FeishuChannelRecord {
  readonly channelId: string
  readonly appId: string
  readonly updatedAt: number
}
