/** Feishu Gateway coordinator: one Thread owns one durable dsh Session. */

import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { readFile as readLocalFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { boundExecutionCard, renderFeishuCard, splitMarkdownByTables } from './card.ts'
import { feishuGatewayDomainSpec } from './state.ts'
import { createLarkFeishuTransportFactory } from './transport.ts'
import { FeishuInteractions } from './interactions.ts'
import { fileMessageContent, saveMessageResource } from './message-resources.ts'
import type {
  ExecutionCardProjection,
  ExecutionCardStep,
  FeishuChannelConfig,
  FeishuGatewayService,
  FeishuGatewayConfig,
  FeishuFileBlock,
  FeishuMessage,
  FeishuMessageRecord,
  FeishuScheduledTaskRequest,
  FeishuScheduledTaskResult,
  FeishuSendOptions,
  FeishuTarget,
  FeishuThreadRecord,
  FeishuTransport,
  FeishuTransportFactory,
} from './types.ts'

export * from './card.ts'
export * from './state.ts'
export * from './transport.ts'
export type * from './types.ts'

/** Cordis function-plugin name. */
export const name = 'feishu-gateway'
/** Runtime services required by the coordinator. */
export const inject = [
  'agents',
  'attachments',
  'commands',
  'credentials',
  'sessionPersistence',
  'storageDomain',
]

export const Config: z<FeishuGatewayConfig> = z.object({
  workspace: z.string().required(),
  provider: z.string(),
  model: z.string(),
  channels: z.array(z.object({
    id: z.string().required(),
    appId: z.string().required(),
    domain: z.union([z.const('feishu'), z.const('lark')]),
    appSecretEnv: z.string().role('credential-ref'),
    appSecret: z.string().role('secret'),
    groupAllowlist: z.array(z.string()),
    dmMode: z.union([z.const('open'), z.const('allowlist'), z.const('pair'), z.const('disabled')]),
    dmAllowlist: z.array(z.string()),
    requireMention: z.boolean(),
    proactiveTarget: z.object({
      chatId: z.string().required(),
      threadId: z.string(),
    }).default(undefined as unknown as { chatId: string; threadId: string }),
  }).required()).required(),
  defaultChannelId: z.string(),
  streamUpdateIntervalMs: z.number().step(1).min(0).default(300),
  interactionTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(600_000),
  cardMarkdownLimit: z.number().step(1).min(1).default(28_000),
})

interface RuntimeThread {
  key: string
  record: FeishuThreadRecord
  readonly handle: AgentHandle
  readonly agent: Agent
}

interface PendingReset {
  readonly old: RuntimeThread
}

interface LiveCard {
  readonly transport: FeishuTransport
  readonly target: FeishuTarget
  readonly replyOptions: FeishuSendOptions
  readonly firstSeq: number
  messageId?: string
  latest: ExecutionCardProjection
  streamedThinking: string
  readonly streamedToolCalls: Map<string, { name: string; argumentsText: string }>
  settled: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  tail: Promise<void>
}

type GatewayDomain = Domain<typeof feishuGatewayDomainSpec>

function assertConfig(config: FeishuGatewayConfig): void {
  if (!isAbsolute(config.workspace)) throw new Error('feishu-gateway workspace must be an absolute path')
  if (config.channels.length === 0) throw new Error('feishu-gateway requires at least one channel')
  if (config.interactionTimeoutMs !== undefined && (!Number.isInteger(config.interactionTimeoutMs)
    || config.interactionTimeoutMs < 1 || config.interactionTimeoutMs > 2_147_483_647)) {
    throw new Error('feishu-gateway interactionTimeoutMs must be an integer between 1 and 2147483647')
  }
  const ids = new Set<string>()
  for (const channel of config.channels) {
    if (channel.id.trim() !== channel.id || channel.id === '') throw new Error('feishu-gateway channel id must be non-empty and trimmed')
    if (ids.has(channel.id)) throw new Error(`feishu-gateway channel "${channel.id}" is duplicated`)
    ids.add(channel.id)
    if (channel.appId.trim() === '') throw new Error(`feishu-gateway channel "${channel.id}" appId must be non-empty`)
    if ((channel.appSecretEnv === undefined || channel.appSecretEnv.trim() === '')
      && (channel.appSecret === undefined || channel.appSecret.trim() === '')) {
      throw new Error(`feishu-gateway channel "${channel.id}" requires appSecret or appSecretEnv`)
    }
    if (channel.appSecretEnv !== undefined && channel.appSecret !== undefined) {
      throw new Error(`feishu-gateway channel "${channel.id}" cannot set both appSecret and appSecretEnv`)
    }
    if (channel.dmMode === 'allowlist' && (channel.dmAllowlist?.length ?? 0) === 0) {
      throw new Error(`feishu-gateway channel "${channel.id}" dmAllowlist is required when dmMode is allowlist`)
    }
  }
  if (config.defaultChannelId !== undefined && !ids.has(config.defaultChannelId)) {
    throw new Error(`feishu-gateway defaultChannelId "${config.defaultChannelId}" does not name a configured channel`)
  }
  if (config.streamUpdateIntervalMs !== undefined && (!Number.isSafeInteger(config.streamUpdateIntervalMs)
    || config.streamUpdateIntervalMs < 0)) {
    throw new Error('feishu-gateway streamUpdateIntervalMs must be a non-negative safe integer')
  }
  if (config.cardMarkdownLimit !== undefined && (!Number.isSafeInteger(config.cardMarkdownLimit)
    || config.cardMarkdownLimit < 1)) {
    throw new Error('feishu-gateway cardMarkdownLimit must be a positive safe integer')
  }
}

function threadIdOf(message: FeishuMessage): string | undefined {
  return message.threadId
}

/** Create a fresh session when an inbound message has no thread_id. */
function routeIdOf(message: FeishuMessage): string {
  return threadIdOf(message) ?? `message:${message.messageId}`
}

function threadKey(channelId: string, threadId: string): string {
  return `${channelId}:${threadId}`
}

function messageKey(channelId: string, messageId: string): string {
  return `${channelId}:${messageId}`
}

function localWorkspacePath(workspace: string, reference: string): string | undefined {
  if (reference.includes('://')) return undefined
  const root = resolve(workspace)
  const candidate = resolve(workspace, reference)
  const relativePath = relative(root, candidate)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined
  return candidate
}

function newSessionId(): SessionId {
  return SessionId(`feishu-${randomUUID()}`)
}

function imageMediaType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

function jsonArguments(argumentsText: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsText)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringArgument(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Keep the visible tool descriptions compact and useful in the card. */
function toolStep(name: string, argumentsText: string, status: ExecutionCardStep['status']): ExecutionCardStep | undefined {
  const args = jsonArguments(argumentsText)
  const normalized = name.replace(/^tool:/u, '').split(/[/.:]/u).pop()?.toLowerCase() ?? name.toLowerCase()
  switch (normalized) {
    case 'agent':
    case 'task':
      return { label: 'Run sub-agent', icon: 'robot_outlined', status }
    case 'bash':
    case 'exec':
    case 'shell':
      return { label: stringArgument(args, 'description', 'command') ?? name, icon: 'computer_outlined', status }
    case 'edit':
    case 'patch': {
      const path = stringArgument(args, 'file_path', 'path')
      return { label: path === undefined ? name : `Edit "${path}"`, icon: 'edit_outlined', status }
    }
    case 'glob': {
      const pattern = stringArgument(args, 'pattern')
      return { label: pattern === undefined ? name : `Search files by pattern "${pattern}"`, icon: 'card-search_outlined', status }
    }
    case 'grep': {
      const pattern = stringArgument(args, 'pattern')
      const glob = stringArgument(args, 'glob')
      const suffix = glob === undefined ? '' : ` in "${glob}"`
      return { label: pattern === undefined ? name : `Search text by pattern "${pattern}"${suffix}`, icon: 'doc-search_outlined', status }
    }
    case 'webfetch':
    case 'fetch': {
      const url = stringArgument(args, 'url')
      return { label: url === undefined ? name : `Fetch web page from "${url}"`, icon: 'language_outlined', status }
    }
    case 'websearch':
    case 'search': {
      const query = stringArgument(args, 'query')
      return { label: query === undefined ? name : `Search web for "${query}"`, icon: 'search_outlined', status }
    }
    case 'read':
    case 'read_file':
    case 'readfile': {
      const path = stringArgument(args, 'file_path', 'path')
      return { label: path === undefined ? name : `Read file "${path}"`, icon: 'file-link-bitable_outlined', status }
    }
    case 'write':
    case 'write_file':
    case 'writefile': {
      const path = stringArgument(args, 'file_path', 'path')
      return { label: path === undefined ? name : `Write file "${path}"`, icon: 'edit_outlined', status }
    }
    case 'skill': {
      const skill = stringArgument(args, 'skill')
      return { label: skill === undefined ? name : `Load skill "${skill}"`, icon: 'file-link-mindnote_outlined', status }
    }
    case 'toolsearch':
      return undefined
    default:
      return { label: name, icon: 'setting-inter_outlined', status }
  }
}

function cardSteps(events: readonly SessionEvent[]): ExecutionCardStep[] {
  const steps: ExecutionCardStep[] = []
  const calls = new Map<string, { name: string; argumentsText: string; status: ExecutionCardStep['status'] }>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), { name: event.data.name, argumentsText: event.data.arguments, status: 'running' })
    } else if (event.type === 'tool/result') {
      const callId = String(event.data.message.source.callId)
      const call = calls.get(callId)
      if (call !== undefined) call.status = event.data.error === undefined ? 'completed' : 'error'
    }
  }
  const rendered = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'reasoning' && block.text !== '') steps.push({ label: block.text, icon: 'robot_outlined', status: 'completed' })
        if (block.type === 'tool-call') {
          const callId = String(block.id)
          const call = calls.get(callId)
          const step = toolStep(block.name, block.arguments, call?.status ?? 'running')
          if (step !== undefined) {
            steps.push(step)
            rendered.add(callId)
          }
        }
      }
    }
    if (event.type === 'tool/call' && !rendered.has(String(event.data.callId))) {
      const step = toolStep(event.data.name, event.data.arguments, calls.get(String(event.data.callId))?.status ?? 'running')
      if (step !== undefined) steps.push(step)
      rendered.add(String(event.data.callId))
    }
  }
  return steps
}

function finalProjection(events: readonly SessionEvent[], title: string): ExecutionCardProjection {
  let markdown = ''
  let status: ExecutionCardProjection['status'] = 'error'
  let errorText: string | undefined
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text !== '') markdown = text
    }
    if (event.type === 'turn/end') {
      status = event.data.reason.kind === 'completed'
        ? 'completed'
        : event.data.reason.kind === 'aborted' ? 'cancelled' : 'error'
      if (event.data.reason.kind === 'error') errorText = event.data.reason.error.message
    }
  }
  return {
    title,
    status,
    markdown: markdown || (status === 'cancelled' ? 'Turn 已停止。' : status === 'error' && errorText !== undefined ? `处理失败：${errorText}` : ''),
    steps: cardSteps(events),
  }
}

function runningProjection(
  title: string,
  markdown: string,
  steps: readonly ExecutionCardStep[],
  thinking?: string,
): ExecutionCardProjection {
  return { title, status: 'running', markdown, ...thinking === undefined ? {} : { thinking }, steps }
}

function liveSteps(live: LiveCard, events: readonly SessionEvent[]): ExecutionCardStep[] {
  const durable = cardSteps(events)
  const callIds = new Set(events.flatMap(event => event.type === 'tool/call'
    ? [String(event.data.callId)]
    : event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'tool-call' ? [String(block.id)] : [])
      : []))
  const transient: ExecutionCardStep[] = []
  if (live.streamedThinking !== '') transient.push({
    label: live.streamedThinking,
    icon: 'robot_outlined',
    status: 'running',
  })
  for (const [callId, call] of live.streamedToolCalls) {
    if (callIds.has(callId)) continue
    const step = toolStep(call.name, call.argumentsText, 'running')
    if (step !== undefined) transient.push(step)
  }
  if (durable.length === 0) return transient.length === 0 ? [{ label: 'Thinking...', icon: 'robot_outlined', status: 'running' }] : transient
  return [...durable, ...transient]
}

function commandText(result: CommandResult): string {
  return result.text ?? (result.kind === 'success' ? '命令已完成。' : '命令执行失败。')
}

/** Small compatibility surface for dsh releases that predate stat/flush or file blocks. */
type SessionPersistenceCompat = {
  stat?: (id: SessionId) => Promise<unknown>
  list?: () => Promise<readonly unknown[]>
  flush?: () => Promise<void>
}

type AttachmentStoreCompat = AttachmentStore & {
  readFileStream?: (attachment: FeishuFileBlock['attachment']) => AsyncIterable<Uint8Array>
}

async function hasPersistedSession(ctx: Context, sessionId: SessionId): Promise<boolean> {
  const persistence = ctx.sessionPersistence as unknown as SessionPersistenceCompat
  if (persistence.stat !== undefined) return (await persistence.stat(sessionId)) !== undefined
  if (persistence.list === undefined) return false
  const sessions = await persistence.list()
  return sessions.some((value) => {
    if (value === null || typeof value !== 'object') return false
    const candidate = 'header' in value ? value.header : value
    return candidate !== null && typeof candidate === 'object' && 'id' in candidate && String(candidate.id) === String(sessionId)
  })
}

async function flushPersistence(ctx: Context): Promise<void> {
  const flush = (ctx.sessionPersistence as unknown as SessionPersistenceCompat).flush
  if (flush !== undefined) await flush.call(ctx.sessionPersistence)
}

/** The Gateway owns routing and external projection, while dsh owns execution. */
export class FeishuGateway implements FeishuGatewayService {
  private readonly interactions: FeishuInteractions
  private readonly channels = new Map<string, { readonly config: FeishuChannelConfig; readonly transport: FeishuTransport }>()
  private readonly threads = new Map<string, RuntimeThread>()
  private readonly sessionThreads = new Map<string, string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly active = new Set<Promise<void>>()
  private readonly inflightMessages = new Set<string>()
  private readonly pendingResets = new Map<Agent, PendingReset>()
  private readonly unsubscribers: (() => void)[] = []
  private readonly intervalMs: number
  private readonly markdownLimit: number
  private domain: GatewayDomain | undefined
  private closing = false
  private started = false
  private commandsDisposer: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: FeishuGatewayConfig,
    private readonly factory: FeishuTransportFactory,
  ) {
    assertConfig(config)
    this.interactions = new FeishuInteractions(ctx, config.interactionTimeoutMs ?? 600_000)
    this.intervalMs = config.streamUpdateIntervalMs ?? 300
    this.markdownLimit = config.cardMarkdownLimit ?? 28_000
  }

  /** Mount durable state, validate channels, connect every transport, and subscribe. */
  async start(): Promise<void> {
    if (this.started) return
    if (this.closing) throw new Error('feishu-gateway has already been closed')
    const domain = await this.ctx.storageDomain.open(feishuGatewayDomainSpec)
    this.domain = domain
    try {
      this.commandsDisposer = this.registerCommands()
      for (const channelConfig of this.config.channels) {
        const secret = channelConfig.appSecret ?? (channelConfig.appSecretEnv === undefined
          ? undefined
          : (await this.ctx.credentials.resolve(credentialRef(channelConfig.appSecretEnv)))?.value)
        if (secret === undefined) {
          const reference = channelConfig.appSecretEnv === undefined ? 'appSecret' : `credential "${channelConfig.appSecretEnv}"`
          throw new Error(`feishu-gateway channel "${channelConfig.id}" ${reference} is not configured`)
        }
        const transport = this.factory.create({
          channelId: channelConfig.id,
          appId: channelConfig.appId,
          appSecret: secret,
          domain: channelConfig.domain ?? 'feishu',
          policy: {
            ...channelConfig.groupAllowlist === undefined ? {} : { groupAllowlist: channelConfig.groupAllowlist },
            ...channelConfig.dmMode === undefined ? {} : { dmMode: channelConfig.dmMode },
            ...channelConfig.dmAllowlist === undefined ? {} : { dmAllowlist: channelConfig.dmAllowlist },
            ...channelConfig.requireMention === undefined ? {} : { requireMention: channelConfig.requireMention },
          },
        })
        if (transport.channelId !== channelConfig.id) throw new Error(`feishu-gateway transport id mismatch for channel "${channelConfig.id}"`)
        this.channels.set(channelConfig.id, { config: channelConfig, transport })
        await this.channelTable().put(channelConfig.id, {
          channelId: channelConfig.id,
          appId: channelConfig.appId,
          updatedAt: Date.now(),
        })
        this.unsubscribers.push(transport.onCardAction(action => this.interactions.handle(channelConfig.id, action)))
        this.unsubscribers.push(transport.onMessage((message) => { this.enqueue(channelConfig.id, message) }))
      }
      await Promise.all([...this.channels.values()].map(channel => channel.transport.connect()))
      this.started = true
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /**
   * Send one proactive message through the configured default Channel.
   * @param text - markdown text to send.
   * @param target - optional target overriding the Channel's configured target.
   */
  async sendProactive(text: string, target?: FeishuTarget): Promise<void> {
    const resolved = this.resolveTarget(undefined, target)
    const channel = this.channels.get(resolved.channelId)
    if (channel === undefined) throw new Error(`feishu-gateway channel "${resolved.channelId}" is not connected`)
    await channel.transport.sendText(resolved.target, text)
  }

  /** Resolve a configured Channel and its proactive target for another plugin. */
  resolveTarget(channelId?: string, target?: FeishuTarget): { channelId: string; target: FeishuTarget } {
    const resolvedChannelId = channelId ?? this.config.defaultChannelId ?? this.config.channels[0]?.id
    if (resolvedChannelId === undefined) throw new Error('feishu-gateway has no default channel')
    const channel = this.channels.get(resolvedChannelId)
    if (channel === undefined) throw new Error(`feishu-gateway channel "${resolvedChannelId}" is not connected`)
    const resolvedTarget = target ?? channel.config.proactiveTarget
    if (resolvedTarget === undefined) throw new Error(`feishu-gateway channel "${resolvedChannelId}" has no proactive target`)
    return { channelId: resolvedChannelId, target: resolvedTarget }
  }

  /** Resolve the last Feishu destination bound to a live or durable Session. */
  resolveSessionTarget(sessionId: SessionId): { channelId: string; target: FeishuTarget } | undefined {
    const liveKey = this.sessionThreads.get(String(sessionId))
    const live = liveKey === undefined ? undefined : this.threads.get(liveKey)
    if (live !== undefined) {
      return {
        channelId: live.record.channelId,
        target: { chatId: live.record.chatId, threadId: live.record.threadId },
      }
    }
    for (const record of this.threadTable().entries()) {
      if (String(record[1].sessionId) !== String(sessionId)) continue
      return { channelId: record[1].channelId, target: { chatId: record[1].chatId, threadId: record[1].threadId } }
    }
    return undefined
  }

  /** Run a scheduler-owned user turn through the normal Agent and card path. */
  async runScheduledTask(request: FeishuScheduledTaskRequest): Promise<FeishuScheduledTaskResult> {
    if (this.closing || !this.started) throw new Error('feishu-gateway is not running')
    if (request.schedulerId.trim() === '' || request.instruction.trim() === '') {
      throw new Error('feishu-gateway scheduled task requires schedulerId and instruction')
    }
    const resolved = this.resolveTarget(request.channelId, request.target)
    const routeKey = request.sessionId === null
      ? threadKey(resolved.channelId, `scheduled:${request.schedulerId}`)
      : this.sessionThreads.get(String(request.sessionId)) ?? `session:${String(request.sessionId)}`
    const previous = this.tails.get(routeKey) ?? Promise.resolve()
    const job = previous.catch(() => undefined).then(() => this.runScheduledNow(request, resolved.channelId, resolved.target, routeKey))
    const tracked = job.then(() => undefined, () => undefined)
    this.tails.set(routeKey, tracked)
    this.active.add(tracked)
    try {
      return await job
    } finally {
      this.active.delete(tracked)
      if (this.tails.get(routeKey) === tracked) this.tails.delete(routeKey)
    }
  }

  /** Stop ingress, cancel owned Agents, drain work, disconnect transports, and close Gateway State. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.interactions.close()
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.commandsDisposer?.()
    this.commandsDisposer = undefined
    const ownedRuntimes = [
      ...this.threads.values(),
      ...[...this.pendingResets.values()].map(pending => pending.old),
    ]
    const uniqueRuntimes = [...new Map(ownedRuntimes.map(runtime => [runtime.agent, runtime])).values()]
    for (const runtime of uniqueRuntimes) runtime.agent.cancel({ kind: 'disposed' })
    await Promise.allSettled(this.active)
    await Promise.allSettled(uniqueRuntimes.map(runtime => runtime.handle.dispose()))
    await Promise.allSettled([...this.channels.values()].map(channel => channel.transport.disconnect()))
    this.channels.clear()
    await this.domain?.close()
    this.domain = undefined
  }

  private channelTable() {
    if (this.domain === undefined) throw new Error('feishu-gateway state is not open')
    return this.domain.table('channels')
  }

  private threadTable() {
    if (this.domain === undefined) throw new Error('feishu-gateway state is not open')
    return this.domain.table('threads')
  }

  private messageTable() {
    if (this.domain === undefined) throw new Error('feishu-gateway state is not open')
    return this.domain.table('messages')
  }

  private enqueue(channelId: string, message: FeishuMessage): void {
    if (this.closing) return
    const inboundKey = messageKey(channelId, message.messageId)
    if (this.inflightMessages.has(inboundKey)) return
    this.inflightMessages.add(inboundKey)
    const id = threadKey(channelId, routeIdOf(message))
    const current = this.threads.get(id)
    const parsed = parseCommand(message.content)
    const isUrgentStop = parsed?.name === 'stop' && current?.agent.status === 'running'
    const previous = isUrgentStop ? Promise.resolve() : this.tails.get(id) ?? Promise.resolve()
    const job = previous.catch(() => undefined).then(() => this.process(channelId, message))
    const tracked = job.finally(() => {
      this.active.delete(tracked)
      this.inflightMessages.delete(inboundKey)
      for (const [tailKey, tail] of this.tails) {
        if (tail === tracked) this.tails.delete(tailKey)
      }
    })
    if (!isUrgentStop) this.tails.set(id, tracked)
    this.active.add(tracked)
  }

  private async process(channelId: string, message: FeishuMessage): Promise<void> {
    const channel = this.channels.get(channelId)
    if (channel === undefined || !this.isAllowed(channel.config, message)) {
      if (channel !== undefined) await channel.transport.sendText({ chatId: message.chatId }, '当前来源未获授权。')
      return
    }
    const key = threadKey(channelId, routeIdOf(message))
    const duplicate = this.messageTable().get(messageKey(channelId, message.messageId))
    // A persisted row means this Feishu delivery has already been admitted.
    // Never replay a processing row after restart: dsh may have emitted side
    // effects before the process died, and the gateway deliberately does not
    // transparently replay an interrupted Turn.
    if (duplicate !== undefined) return

    let runtime: RuntimeThread | undefined
    try {
      runtime = await this.ensureThread(channel.config, message, key)
      const blocks = await this.admitResources(channelId, channel.transport, message)
      await this.messageTable().put(messageKey(channelId, message.messageId), {
        channelId,
        messageId: message.messageId,
        threadKey: key,
        sessionId: runtime.record.sessionId,
        state: 'processing',
        updatedAt: Date.now(),
      } satisfies FeishuMessageRecord)

      const command = parseCommand(message.content)
      if (command !== undefined && this.ctx.commands.find(runtime.agent, command.name) !== undefined) {
        const execution = await this.ctx.commands.execute(runtime.agent, message.content, [], new AbortController().signal)
        if (execution !== undefined) {
          const pending = this.pendingResets.get(runtime.agent)
          this.pendingResets.delete(runtime.agent)
          if (pending !== undefined) {
            await channel.transport.sendText(this.targetOf(message), commandText(execution.result), this.replyOptions(message))
            await pending.old.handle.dispose()
          } else {
            await channel.transport.sendText(this.targetOf(message), commandText(execution.result), this.replyOptions(message))
          }
          await this.messageTable().update(messageKey(channelId, message.messageId), current => ({ ...current, state: 'completed', updatedAt: Date.now() }))
          return
        }
      }

      const userMessage = createUserMessage({ content: blocks, source: { kind: 'user' } })
      await this.runTurn(channel.transport, this.targetOf(message), this.replyOptions(message), runtime, userMessage, message.senderId)
      await this.messageTable().update(messageKey(channelId, message.messageId), current => ({ ...current, state: 'completed', updatedAt: Date.now() }))
    } catch (error: unknown) {
      if (runtime !== undefined) {
        await this.messageTable().put(messageKey(channelId, message.messageId), {
          channelId,
          messageId: message.messageId,
          threadKey: key,
          sessionId: runtime.record.sessionId,
          state: 'rejected',
          updatedAt: Date.now(),
        }).catch(() => undefined)
      }
      const text = error instanceof Error ? error.message : 'Feishu Gateway 处理失败。'
      await channel.transport.sendText(this.targetOf(message), `处理失败：${text}`, this.replyOptions(message)).catch(() => undefined)
      this.ctx.logger.warn(`feishu-gateway message ${JSON.stringify(message.messageId)} failed: ${text}`)
    }
  }

  private isAllowed(config: FeishuChannelConfig, message: FeishuMessage): boolean {
    if (message.chatType === 'group') {
      return config.groupAllowlist === undefined
        || config.groupAllowlist.length === 0
        || config.groupAllowlist.includes(message.chatId)
    }
    if (config.dmMode === 'disabled') return false
    if (config.dmMode === 'allowlist') return config.dmAllowlist?.includes(message.senderId) ?? false
    return config.dmAllowlist === undefined
      || config.dmAllowlist.length === 0
      || config.dmAllowlist.includes(message.senderId)
  }

  private async ensureThread(config: FeishuChannelConfig, message: FeishuMessage, key: string): Promise<RuntimeThread> {
    const live = this.threads.get(key)
    if (live !== undefined) return live
    const threadId = threadIdOf(message)
    // The gateway only reads the durable mapping when Feishu supplied a
    // thread_id. A first message without one receives a fresh Session; the
    // reply's returned thread_id becomes the durable route after send.
    let record = threadId === undefined ? undefined : this.threadTable().get(key)
    if (record === undefined) {
      record = {
        channelId: config.id,
        threadId: threadId ?? `message:${message.messageId}`,
        chatId: message.chatId,
        sessionId: newSessionId(),
        workspace: this.config.workspace,
        updatedAt: Date.now(),
      }
      const handle = await this.createOrResume(record.sessionId)
      if (threadId !== undefined) {
        try {
          await this.threadTable().put(key, record)
        } catch (error) {
          await handle.dispose()
          throw error
        }
      }
      const runtime = { key, record, handle, agent: handle.agent }
      this.threads.set(key, runtime)
      this.sessionThreads.set(String(record.sessionId), key)
      return runtime
    }
    const handle = await this.createOrResume(record.sessionId)
    const runtime = { key, record, handle, agent: handle.agent }
    this.threads.set(key, runtime)
    this.sessionThreads.set(String(record.sessionId), key)
    return runtime
  }

  private async runScheduledNow(
    request: FeishuScheduledTaskRequest,
    channelId: string,
    target: FeishuTarget,
    routeKey: string,
  ): Promise<FeishuScheduledTaskResult> {
    const channel = this.channels.get(channelId)
    if (channel === undefined) throw new Error(`feishu-gateway channel "${channelId}" is not connected`)
    let runtime: RuntimeThread | undefined
    if (request.sessionId !== null) {
      const liveKey = this.sessionThreads.get(String(request.sessionId))
      runtime = liveKey === undefined ? undefined : this.threads.get(liveKey)
      if (runtime === undefined) {
        for (const [key, record] of this.threadTable().entries()) {
          if (String(record.sessionId) !== String(request.sessionId)) continue
          const handle = await this.createOrResume(request.sessionId)
          runtime = { key, record, handle, agent: handle.agent }
          this.threads.set(key, runtime)
          this.sessionThreads.set(String(record.sessionId), key)
          break
        }
      }
    }
    if (runtime === undefined) {
      const sessionId = request.sessionId ?? newSessionId()
      const record: FeishuThreadRecord = {
        channelId,
        threadId: target.threadId ?? routeKey,
        chatId: target.chatId,
        sessionId,
        workspace: this.config.workspace,
        updatedAt: Date.now(),
      }
      const handle = await this.createOrResume(sessionId)
      runtime = { key: routeKey, record, handle, agent: handle.agent }
      this.threads.set(routeKey, runtime)
      this.sessionThreads.set(String(sessionId), routeKey)
      await this.threadTable().put(routeKey, record)
    }
    const scheduleLine = request.scheduleDescription === undefined ? '' : `\n> Schedule: ${request.scheduleDescription}`
    const framed = [
      '> This message was automatically triggered by a scheduled task.',
      `> Triggered at: ${new Date().toISOString()}`,
      `> Scheduler ID: \`${request.schedulerId}\`${scheduleLine}`,
      '',
      request.instruction,
    ].join('\n')
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: framed }],
      source: { kind: 'plugin', plugin: 'feishu-cron' },
    })
    // Prefer the persisted message anchor for an existing conversation. Only
    // configured topics without a known card need a transport history lookup.
    const replyOptions = target.threadId !== undefined
      && runtime.record.channelId === channelId
      && runtime.record.chatId === target.chatId
      && runtime.record.threadId === target.threadId
      && runtime.record.cardMessageId !== undefined
      ? { replyTo: runtime.record.cardMessageId, replyInThread: true }
      : {}
    await this.runTurn(channel.transport, target, replyOptions, runtime, userMessage)
    return {
      sessionId: runtime.record.sessionId,
      ...runtime.record.cardMessageId === undefined ? {} : { messageId: runtime.record.cardMessageId },
      threadId: runtime.record.threadId,
    }
  }

  private async createOrResume(sessionId: SessionId): Promise<AgentHandle> {
    const persisted = await hasPersistedSession(this.ctx, sessionId)
    const agentOptions = {
      ...this.config.provider === undefined ? {} : { provider: this.config.provider },
      ...this.config.model === undefined ? {} : { model: this.config.model },
    }
    return !persisted
      ? this.ctx.agents.create({ sessionId, meta: { cwd: this.config.workspace }, agentOptions })
      : this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
  }

  private async admitResources(
    channelId: string,
    transport: FeishuTransport,
    message: FeishuMessage,
  ): Promise<ContentBlock[]> {
    const blocks = await this.admitMessageResources(transport, message)
    const parentId = message.replyToMessageId
    if (parentId === undefined || parentId === message.messageId) return blocks
    // Feishu topic replies carry the topic root in parent_id even when the
    // user did not explicitly quote that message. If the Gateway already saw
    // the root, do not fetch it again or report it as a new attachment
    // failure. This remains true after a restart or /reset changes the Session.
    const parent = message.rootId === parentId
      ? this.messageTable().get(messageKey(channelId, parentId))
      : undefined
    if (parent !== undefined) return blocks
    let resources: FeishuMessage['resources']
    try {
      resources = await transport.getMessageResources(parentId, message.chatId)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Unknown message lookup error'
      blocks.push({ type: 'text', text: `被回复消息的附件读取失败：${reason}。附件内容未提供，不能声称已读取该附件。` })
      this.ctx.logger.warn(`feishu-gateway replied message ${JSON.stringify(parentId)} lookup failed: ${reason}`)
      return blocks
    }
    if (resources.length !== 0) {
      blocks.push({ type: 'text', text: '以下附件来自本次明确回复的消息。' })
      blocks.push(...await this.admitMessageResources(transport, { ...message, messageId: parentId, content: '', resources }))
    }
    return blocks
  }

  private async admitMessageResources(transport: FeishuTransport, message: FeishuMessage): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = []
    if (message.content !== '') blocks.push({ type: 'text', text: message.content })
    if (message.resources.length === 0) return blocks
    const store = this.ctx.get('attachments') as AttachmentStoreCompat | undefined
    for (const resource of message.resources) {
      try {
        const type = resource.type === 'image' ? 'image' : 'file'
        const bytes = await transport.downloadResource(message.messageId, resource.fileKey, type)
        if (resource.type === 'image') {
          if (store === undefined) throw new Error('附件不可用：当前 profile 没有挂载 dsh Attachment store')
          const mediaType = imageMediaType(bytes)
          if (mediaType === undefined) throw new Error(`图片 ${resource.fileKey} 的格式不受支持`)
          const attachment = await store.saveImage({
            data: bytes,
            mediaType,
            ...resource.fileName === undefined ? {} : { name: resource.fileName },
          })
          blocks.push({ type: 'image', attachment })
        } else {
          const path = await saveMessageResource(this.config.workspace, bytes, resource.fileName ?? `${resource.type}-${resource.fileKey}`)
          blocks.push(fileMessageContent(path))
        }
      } catch (error: unknown) {
        // Keep admission failures in the normal logged user message so later turns can explain them.
        const reason = error instanceof Error ? error.message : 'Unknown attachment error'
        blocks.push({ type: 'text', text: `附件接入失败（${JSON.stringify(resource.fileName ?? resource.fileKey)}）：${reason}。该附件内容未提供给模型，不能据此声称已读取或识别该附件。` })
        this.ctx.logger.warn(`feishu-gateway resource in message ${JSON.stringify(message.messageId)} failed: ${reason}`)
      }
    }
    return blocks
  }

  private targetOf(message: FeishuMessage): FeishuTarget {
    const threadId = message.threadId
    return { chatId: message.chatId, ...threadId === undefined ? {} : { threadId } }
  }

  private replyOptions(message: FeishuMessage): FeishuSendOptions {
    // The gateway always creates the first assistant card with
    // message.reply(..., reply_in_thread: true), including a first message
    // that did not already belong to a topic.
    return { replyTo: message.messageId, replyInThread: true }
  }

  private renderCard(transport: FeishuTransport, projection: ExecutionCardProjection): Promise<Readonly<Record<string, unknown>>> {
    const uploadImage = transport.uploadImage?.bind(transport)
    return renderFeishuCard(projection, this.markdownLimit, {
      workspace: this.config.workspace,
      ...uploadImage === undefined ? {} : { uploadImage },
    })
  }

  /** Persist the thread returned by Feishu's reply API against this Session. */
  private async bindReplyThread(
    runtime: RuntimeThread,
    channelId: string,
    chatId: string,
    threadId: string | undefined,
  ): Promise<void> {
    if (threadId === undefined) return
    const nextKey = threadKey(channelId, threadId)
    const previousKey = runtime.key
    runtime.key = nextKey
    runtime.record = {
      ...runtime.record,
      channelId,
      threadId,
      chatId,
      updatedAt: Date.now(),
    }
    if (previousKey !== nextKey) {
      const currentTail = this.tails.get(previousKey)
      if (currentTail !== undefined) this.tails.set(nextKey, currentTail)
      this.threads.delete(previousKey)
      await this.threadTable().delete(previousKey)
      this.threads.set(nextKey, runtime)
    }
    await this.threadTable().put(nextKey, runtime.record)
    this.sessionThreads.set(String(runtime.record.sessionId), nextKey)
  }

  private async runTurn(
    transport: FeishuTransport,
    target: FeishuTarget,
    replyOptions: FeishuSendOptions,
    runtime: RuntimeThread,
    userMessage: ReturnType<typeof createUserMessage>,
    userId?: string,
  ): Promise<void> {
    const firstSeq = runtime.agent.session.seq
    const live: LiveCard = {
      transport,
      target,
      replyOptions,
      firstSeq,
      latest: runningProjection('DeepSeek Harness', '', [{
        label: 'Thinking...',
        icon: 'robot_outlined',
        status: 'running',
      }]),
      streamedThinking: '',
      streamedToolCalls: new Map(),
      settled: false,
      timer: undefined,
      tail: Promise.resolve(),
    }
    const initial = await transport.sendCard(live.target, await this.renderCard(transport, live.latest), live.replyOptions)
    live.messageId = initial.messageId
    await this.bindReplyThread(runtime, transport.channelId, target.chatId, initial.threadId)
    runtime.record = { ...runtime.record, cardMessageId: initial.messageId, updatedAt: Date.now() }
    await this.threadTable().put(runtime.key, runtime.record)
    let streamedText = ''
    let usesLiveStream = false
    const snapshot = (): readonly SessionEvent[] => runtime.agent.session.snapshotEvents().slice(firstSeq)
    const resetAttempt = (): void => {
      streamedText = ''
      live.streamedThinking = ''
      live.streamedToolCalls.clear()
    }
    const refresh = (): void => {
      const events = snapshot()
      live.latest = runningProjection(
        live.latest.title,
        streamedText || finalProjection(events, live.latest.title).markdown,
        liveSteps(live, events),
      )
      this.scheduleCardPatch(live)
    }
    const consumeChunk = (chunk: StreamChunk): void => {
      if (chunk.type === 'reasoning-delta') live.streamedThinking += chunk.text
      else if (chunk.type === 'tool-call-delta') {
        const existing = live.streamedToolCalls.get(String(chunk.id))
        live.streamedToolCalls.set(String(chunk.id), {
          name: chunk.name ?? existing?.name ?? 'tool',
          argumentsText: `${existing?.argumentsText ?? ''}${chunk.argumentsDelta}`,
        })
      } else if (chunk.type === 'text-delta') streamedText += chunk.text
      else return
      refresh()
    }
    // Newer hosts publish transient frames separately from the durable Session log.
    // Keep the narrow public-event compatibility boundary until the peer minimum
    // includes AssistantStreamFrame; do not import an adjacent source checkout.
    const onStream = this.ctx.on.bind(this.ctx) as unknown as (
      name: 'agent/assistant-stream',
      listener: (payload: { agent: Agent; frame:
        | { type: 'start' | 'end' }
        | { type: 'chunk'; chunk: StreamChunk }
      }) => void,
    ) => () => void
    const disposeStream = onStream('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== runtime.agent || live.settled) return
      usesLiveStream = true
      if (frame.type === 'chunk') consumeChunk(frame.chunk)
      else {
        resetAttempt()
        refresh()
      }
    })
    const disposeSession = this.ctx.on('session/event', (session, event) => {
      if (session !== runtime.agent.session || live.settled) return
      if (event.type === 'assistant/chunk') {
        if (!usesLiveStream) consumeChunk(event.data.chunk)
      } else if (event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result') {
        if (event.type === 'assistant/message') resetAttempt()
        refresh()
      }
    })
    let waitingCount = 0
    const disposeInteractions = userId === undefined ? () => {} : this.interactions.bind({
      agent: runtime.agent, transport, target: { chatId: runtime.record.chatId, threadId: runtime.record.threadId },
      anchor: initial.messageId, userId,
      waiting: active => {
        if (live.settled) return
        waitingCount += active ? 1 : -1
        live.latest = { ...live.latest, title: waitingCount > 0 ? '等待你的确认或回答' : 'DeepSeek Harness' }
        this.scheduleCardPatch(live)
      },
    })
    try {
      runtime.agent.followup(userMessage)
      await runtime.agent.whenIdle()
      await flushPersistence(this.ctx)
      const events = runtime.agent.session.snapshotEvents().slice(firstSeq)
      live.settled = true
      live.latest = finalProjection(events, 'DeepSeek Harness')
      await live.tail
      try {
        const markdownChunks = splitMarkdownByTables(live.latest.markdown)
        const firstMarkdown = markdownChunks[0] ?? ''
        await transport.updateCard(live.messageId, await this.renderCard(transport, { ...live.latest, markdown: firstMarkdown }))
        await this.sendRemainingCards(transport, live, markdownChunks.slice(1))
      } catch (cardError: unknown) {
        const fallback = boundExecutionCard(live.latest, this.markdownLimit).markdown
        await transport.sendText(
          live.target,
          fallback,
          { replyTo: live.messageId, replyInThread: true },
        ).catch((fallbackError: unknown) => {
          throw new Error('Feishu Execution Card 更新失败，且文本降级回复也失败。', { cause: fallbackError ?? cardError })
        })
      }
      await this.sendProducedAttachments(transport, live, events)
      await this.sendLocalFileAttachments(transport, live, live.latest.markdown)
    } catch (error) {
      live.settled = true
      await live.tail.catch(() => undefined)
      const text = error instanceof Error ? error.message : 'Turn 执行失败。'
      await transport.updateCard(live.messageId, await this.renderCard(transport, {
        title: 'DeepSeek Harness',
        status: 'error',
        markdown: `处理失败：${text}`,
        steps: live.latest.steps,
      })).catch(() => undefined)
      throw error
    } finally {
      if (live.timer !== undefined) clearTimeout(live.timer)
      disposeInteractions()
      disposeStream()
      disposeSession()
    }
  }

  private scheduleCardPatch(live: LiveCard): void {
    if (live.messageId === undefined || live.settled) return
    if (this.intervalMs === 0) {
      this.queueCardPatch(live)
      return
    }
    if (live.timer !== undefined) return
    live.timer = setTimeout(() => {
      live.timer = undefined
      this.queueCardPatch(live)
    }, this.intervalMs)
  }

  private queueCardPatch(live: LiveCard): void {
    if (live.messageId === undefined || live.settled) return
    const messageId = live.messageId
    const projection = live.latest
    live.tail = live.tail
      .then(async () => live.transport.updateCard(messageId, await this.renderCard(live.transport, projection)))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`feishu-gateway live card ${JSON.stringify(messageId)} update failed: ${reason}`)
      })
  }

  private async sendProducedAttachments(
    transport: FeishuTransport,
    live: LiveCard,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const store = this.ctx.get('attachments') as AttachmentStoreCompat | undefined
    if (store === undefined) return
    const messageId = live.messageId
    if (messageId === undefined) return
    const target = live.target
    const options: FeishuSendOptions = { replyTo: messageId, replyInThread: true }
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content as readonly (ContentBlock | FeishuFileBlock)[]) {
        if (block.type === 'file') await transport.sendFile(target, await readFileAttachment(store, block), block.attachment.name ?? 'file', options)
        if (block.type === 'image') await transport.sendImage(target, await readImageAttachment(store, block), block.attachment.name ?? 'image', options)
      }
    }
  }

  /** Reply with local files referenced by the final Markdown. */
  private async sendLocalFileAttachments(
    transport: FeishuTransport,
    live: LiveCard,
    markdown: string,
  ): Promise<void> {
    if (live.messageId === undefined) return
    const paths = new Set<string>()
    const links = /(?<!!)\[.*?\]\(([^)]+)\)/g
    let match: RegExpExecArray | null
    while ((match = links.exec(markdown)) !== null) {
      const reference = match[1]
      if (reference === undefined) continue
      const path = localWorkspacePath(this.config.workspace, reference)
      if (path !== undefined) paths.add(path)
    }
    for (const path of paths) {
      try {
        if (!(await stat(path)).isFile()) continue
        await transport.sendFile(
          live.target,
          await readLocalFile(path),
          basename(path),
          { replyTo: live.messageId, replyInThread: true },
        )
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'unknown error'
        this.ctx.logger.warn(`feishu-gateway local attachment ${JSON.stringify(path)} failed: ${reason}`)
      }
    }
  }

  /** Send table overflow as interactive cards in the same Feishu thread. */
  private async sendRemainingCards(transport: FeishuTransport, live: LiveCard, chunks: readonly string[]): Promise<void> {
    if (live.messageId === undefined) return
    for (const chunk of chunks) {
      await transport.sendCard(live.target, await this.renderCard(transport, {
        title: 'DeepSeek Harness',
        status: 'completed',
        markdown: chunk,
        steps: [],
      }), { replyTo: live.messageId, replyInThread: true })
    }
  }

  private registerCommands(): () => void {
    const disposers = [
      this.ctx.commands.register({
        name: 'help',
        description: '查看 Feishu Gateway 命令',
        handler: ({ rawInput }: CommandInvocation): CommandResult => rawInput.trim() === ''
          ? { kind: 'success', text: '/stop 停止当前 Turn\n/reset 重置当前会话\n/help 查看帮助\n/status 查看状态' }
          : { kind: 'error', text: '用法：/help' },
      }),
      this.ctx.commands.register({
        name: 'status',
        description: '查看当前 Session 和 Turn 状态',
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult => rawInput.trim() === ''
          ? { kind: 'success', text: `Session ${String(agent.session.id)}\n状态：${agent.status}\n事件数：${String(agent.session.seq)}` }
          : { kind: 'error', text: '用法：/status' },
      }),
      this.ctx.commands.register({
        name: 'stop',
        description: '停止当前 Turn',
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult => {
          if (rawInput.trim() !== '') return { kind: 'error', text: '用法：/stop' }
          if (agent.status !== 'running') return { kind: 'success', text: '当前没有正在运行的 Turn。' }
          agent.cancel({ kind: 'user' })
          return { kind: 'success', text: '已请求停止当前 Turn。' }
        },
      }),
      this.ctx.commands.register({
        name: 'reset',
        description: '为当前 Thread 创建新 Session',
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult | Promise<CommandResult> => {
          if (rawInput.trim() !== '') return { kind: 'error', text: '用法：/reset' }
          return this.resetAgent(agent)
        },
      }),
    ]
    return () => { for (const dispose of disposers.splice(0)) dispose() }
  }

  private async resetAgent(agent: Agent): Promise<CommandResult> {
    const key = this.sessionThreads.get(String(agent.session.id))
    if (key === undefined) return { kind: 'error', text: '当前 Agent 不属于 Feishu Thread。' }
    const old = this.threads.get(key)
    if (old === undefined) return { kind: 'error', text: '当前 Thread 没有活动 Session。' }
    old.agent.cancel({ kind: 'user' })
    await old.agent.whenIdle()
    const nextId = SessionId(`feishu-${randomUUID()}`)
    const nextHandle = await this.createOrResume(nextId)
    const { cardMessageId: _oldCardMessageId, ...oldRecord } = old.record
    const nextRecord: FeishuThreadRecord = { ...oldRecord, sessionId: nextId, updatedAt: Date.now() }
    try {
      await this.threadTable().put(key, nextRecord)
    } catch (error) {
      await nextHandle.dispose()
      throw error
    }
    const next = { key, record: nextRecord, handle: nextHandle, agent: nextHandle.agent }
    this.threads.set(key, next)
    this.sessionThreads.delete(String(old.record.sessionId))
    this.sessionThreads.set(String(nextId), key)
    this.pendingResets.set(agent, { old })
    return { kind: 'success', text: '已重置当前 Thread，后续消息将使用新 Session。' }
  }
}

async function readFileAttachment(store: AttachmentStoreCompat, block: FeishuFileBlock): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  if (store.readFileStream === undefined) return new Uint8Array()
  for await (const chunk of store.readFileStream(block.attachment)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function readImageAttachment(store: AttachmentStore, block: ImageBlock): Promise<Uint8Array> {
  return (await store.readImage(block.attachment)).data
}

/** Loader entry using the official Feishu Channel SDK adapter. */
export async function apply(ctx: Context, config: FeishuGatewayConfig): Promise<void> {
  const gateway = new FeishuGateway(ctx, config, createLarkFeishuTransportFactory())
  ctx.effect(() => async () => {
    await gateway.close()
  }, 'feishu-gateway.lifecycle()')
  await gateway.start()
  ctx.provide('feishuGateway', gateway)
}

/**
 * Test and embedding seam: run the same Gateway with a fake transport factory.
 * @param ctx - Cordis context providing dsh capabilities.
 * @param config - validated Feishu Gateway configuration.
 * @param factory - transport constructor for production or tests.
 * @returns the started Gateway, owned by the caller for teardown.
 */
export async function startFeishuGateway(
  ctx: Context,
  config: FeishuGatewayConfig,
  factory: FeishuTransportFactory,
): Promise<FeishuGateway> {
  const gateway = new FeishuGateway(ctx, config, factory)
  await gateway.start()
  return gateway
}
