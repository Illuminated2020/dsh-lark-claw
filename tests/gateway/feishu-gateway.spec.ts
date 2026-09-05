/* oxlint-disable typescript/no-explicit-any -- These fakes intentionally use erased structural shapes at the Cordis boundary. */
/* oxlint-disable typescript/no-unsafe-assignment -- The erased fake shapes are asserted by the behavior tests below. */
/* oxlint-disable typescript/no-unsafe-argument -- The erased fake shapes are asserted by the behavior tests below. */
/* oxlint-disable typescript/no-unsafe-call -- The erased fake shapes are asserted by the behavior tests below. */
/* oxlint-disable typescript/no-unsafe-member-access -- The erased fake shapes are asserted by the behavior tests below. */
/* oxlint-disable typescript/no-unsafe-return -- The erased fake shapes are asserted by the behavior tests below. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Config, startFeishuGateway } from '../../src/gateway/index.ts'
import type {
  FeishuGatewayConfig,
  FeishuMessage,
  FeishuSendOptions,
  FeishuTarget,
  FeishuTransport,
  FeishuTransportConfig,
} from '../../src/gateway/types.ts'

const testWorkspaces: string[] = []
afterEach(async () => {
  for (const path of testWorkspaces.splice(0)) await rm(path, { recursive: true, force: true })
})

type AnyHandler = (payload: any) => void

interface MemoryState {
  readonly tables: Map<string, Map<string, any>>
  readonly persistedSessions: Set<string>
}

function memoryState(): MemoryState {
  return {
    tables: new Map([
      ['channels', new Map()],
      ['threads', new Map()],
      ['messages', new Map()],
    ]),
    persistedSessions: new Set(),
  }
}

function table(state: MemoryState, name: string) {
  const records = state.tables.get(name) ?? new Map()
  state.tables.set(name, records)
  return {
    get: (key: string) => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size },
    put: async (key: string, value: unknown) => { records.set(key, value) },
    delete: async (key: string) => records.delete(key),
    update: async (key: string, fn: (value: any) => any) => {
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    },
  }
}

class FakeTransport implements FeishuTransport {
  readonly cards: { messageId: string; target: FeishuTarget; card: Readonly<Record<string, unknown>>; options?: FeishuSendOptions }[] = []
  readonly updates: { messageId: string; card: Readonly<Record<string, unknown>> }[] = []
  readonly texts: { target: FeishuTarget; text: string; options?: FeishuSendOptions }[] = []
  readonly images: { target: FeishuTarget; data: Uint8Array; fileName: string }[] = []
  readonly files: { target: FeishuTarget; data: Uint8Array; fileName: string }[] = []
  readonly configs: FeishuTransportConfig[] = []
  connected = false
  disconnected = false
  failUpdates = false
  private handler: ((message: FeishuMessage) => void | Promise<void>) | undefined
  private nextMessage = 0

  constructor(readonly channelId: string, config: FeishuTransportConfig) {
    this.configs.push(config)
  }

  onMessage(handler: (message: FeishuMessage) => void | Promise<void>): () => void {
    this.handler = handler
    return () => { this.handler = undefined }
  }

  async connect(): Promise<void> { this.connected = true }
  async disconnect(): Promise<void> { this.disconnected = true }

  async sendCard(
    target: FeishuTarget,
    card: Readonly<Record<string, unknown>>,
    options?: FeishuSendOptions,
  ): Promise<{ messageId: string; threadId: string }> {
    const messageId = `card-${this.channelId}-${String(++this.nextMessage)}`
    this.cards.push({ messageId, target, card, ...options === undefined ? {} : { options } })
    return { messageId, threadId: target.threadId ?? `reply-thread-${messageId}` }
  }

  async updateCard(messageId: string, card: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.failUpdates) throw new Error('card update failed')
    this.updates.push({ messageId, card })
  }

  async sendText(target: FeishuTarget, text: string, options?: FeishuSendOptions): Promise<{ messageId: string }> {
    this.texts.push({ target, text, ...options === undefined ? {} : { options } })
    return { messageId: `text-${this.channelId}-${String(this.texts.length)}` }
  }

  async sendImage(target: FeishuTarget, data: Uint8Array, fileName: string): Promise<{ messageId: string }> {
    this.images.push({ target, data, fileName })
    return { messageId: `image-${this.channelId}-${String(this.images.length)}` }
  }

  async sendFile(target: FeishuTarget, data: Uint8Array, fileName: string): Promise<{ messageId: string }> {
    this.files.push({ target, data, fileName })
    return { messageId: `file-${this.channelId}-${String(this.files.length)}` }
  }

  getMessageResources = vi.fn(async (): Promise<FeishuMessage['resources']> => [])

  async downloadResource(_messageId: string, fileKey: string, type: 'image' | 'file'): Promise<Uint8Array> {
    if (type === 'image') return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
    return new TextEncoder().encode(`downloaded:${fileKey}`)
  }

  emit(message: FeishuMessage): void {
    void this.handler?.(message)
  }
}

class FakeAgent {
  readonly session: any
  readonly followed: any[] = []
  status: 'idle' | 'running' = 'idle'
  private readonly events: any[] = []
  private idle: Promise<void> = Promise.resolve()
  private resolveIdle: (() => void) | undefined

  constructor(
    readonly id: SessionId,
    private readonly emit: (event: string, payload: unknown) => void,
    private readonly persisted: Set<string>,
    private readonly turnGate?: Promise<void>,
  ) {
    this.session = {
      id,
      get seq() { return this.eventsLength() },
      eventsLength: () => this.events.length,
      snapshotEvents: () => [...this.events],
    }
  }

  followup(message: unknown): void {
    this.status = 'running'
    this.idle = new Promise((resolve) => { this.resolveIdle = resolve })
    this.followed.push(message)
    this.events.push({ type: 'user/message', seq: this.events.length, data: { content: [{ type: 'text', text: 'user' }] } })
    this.emit('agent/assistant-stream', {
      agent: this,
      frame: {
        type: 'chunk',
        attemptId: 'attempt-1',
        revision: 1,
        index: 0,
        time: Date.now(),
        chunk: { type: 'text-delta', text: '来自 dsh 的回答' },
      },
    })
    const finish = (): void => {
      if (this.status !== 'running') return
      this.events.push({
        type: 'assistant/message',
        seq: this.events.length,
        data: { message: { content: [{ type: 'text', text: '来自 dsh 的回答' }] }, stream: [] },
      })
      this.events.push({ type: 'turn/end', seq: this.events.length, data: { reason: { kind: 'completed' } } })
      this.persisted.add(String(this.id))
      this.status = 'idle'
      this.resolveIdle?.()
      this.resolveIdle = undefined
    }
    if (this.turnGate === undefined) finish()
    else void this.turnGate.then(finish)
  }

  whenIdle(): Promise<void> { return this.idle }
  cancel(): void {
    this.status = 'idle'
    this.resolveIdle?.()
    this.resolveIdle = undefined
  }
}

interface Harness {
  readonly ctx: Context
  readonly state: MemoryState
  readonly transports: Map<string, FakeTransport>
  readonly agents: FakeAgent[]
  readonly creates: SessionId[]
  readonly resumes: SessionId[]
  readonly emit: (event: string, payload: unknown) => void
  readonly attachments: any
}

function harness(state = memoryState(), withAttachments = false, turnGate?: Promise<void>): Harness {
  const eventHandlers = new Map<string, Set<AnyHandler>>()
  const commandDefinitions = new Map<string, any>()
  const transports = new Map<string, FakeTransport>()
  const agents: FakeAgent[] = []
  const creates: SessionId[] = []
  const resumes: SessionId[] = []
  const attachments = withAttachments
    ? {
      saveImage: vi.fn(async (input: any) => ({ id: 'image-1', name: input.name, mediaType: input.mediaType, bytes: input.data.byteLength })),
      readImage: vi.fn(),
      readFileStream: vi.fn(),
    }
    : undefined
  const emit = (event: string, payload: unknown): void => {
    for (const handler of eventHandlers.get(event) ?? []) handler(payload)
  }
  const makeAgent = (id: SessionId): AgentHandle => {
    const agent = new FakeAgent(id, emit, state.persistedSessions, turnGate)
    agents.push(agent)
    return {
      agent: agent as unknown as Agent,
      dispose: async () => { agent.cancel() },
    }
  }
  const context = {
    storageDomain: {
      open: async () => ({
        table: (name: string) => table(state, name),
        close: async () => undefined,
      }),
    },
    credentials: { resolve: async () => ({ value: 'app-secret', source: 'test' }) },
    sessionPersistence: {
      stat: async (id: SessionId) => state.persistedSessions.has(String(id)) ? { header: { id }, revision: 1 } : undefined,
      flush: async () => undefined,
    },
    agents: {
      create: async ({ sessionId }: { sessionId: SessionId }) => { creates.push(sessionId); return makeAgent(sessionId) },
      resume: async ({ resumeSessionId }: { resumeSessionId: SessionId }) => {
        resumes.push(resumeSessionId)
        return makeAgent(resumeSessionId)
      },
    },
    commands: {
      register: (definition: any) => {
        commandDefinitions.set(definition.name, definition)
        return () => { commandDefinitions.delete(definition.name) }
      },
      find: (_agent: Agent, name: string) => commandDefinitions.get(name),
      execute: async (agent: Agent, line: string) => {
        const match = /^\/([^\s]+)(?:\s([\s\S]*))?$/u.exec(line)
        const commandName = match?.[1]
        const definition = commandName === undefined ? undefined : commandDefinitions.get(commandName)
        if (definition === undefined) return undefined
        const result = await definition.handler({
          commandId: 'command-1',
          agent,
          rawInput: match?.[2] ?? '',
          attachments: [],
          signal: new AbortController().signal,
        })
        return { commandId: 'command-1', result }
      },
    },
    get: (key: string) => key === 'attachments' ? attachments : undefined,
    on: (event: string, handler: AnyHandler) => {
      const handlers = eventHandlers.get(event) ?? new Set<AnyHandler>()
      handlers.add(handler)
      eventHandlers.set(event, handlers)
      return () => { handlers.delete(handler) }
    },
    effect: () => undefined,
    logger: { warn: vi.fn() },
  }
  return {
    ctx: context as unknown as Context,
    state,
    transports,
    agents,
    creates,
    resumes,
    emit,
    attachments,
  }
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    messageId: 'message-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'user-1',
    content: '你好',
    resources: [],
    receivedAt: Date.now(),
    ...overrides,
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('test condition did not settle')
}

const gateways: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close()
})

describe('Feishu Gateway', () => {
  it('treats omitted source allowlists as open after config normalization', async () => {
    const h = harness()
    const gateway = await startFeishuGateway(h.ctx, Config({
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET', proactiveTarget: { chatId: 'group-1' } }],
    }), { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!

    transport.emit(message({ messageId: 'p2p-message' }))
    await eventually(() => h.agents[0]?.followed.length === 1)

    transport.emit(message({ messageId: 'group-message', chatType: 'group', chatId: 'group-1' }))
    await eventually(() => h.agents.reduce((total, agent) => total + agent.followed.length, 0) === 2)
    expect(transport.texts).toHaveLength(0)
  })

  it('routes one Thread to one durable Session, emits one final card, and deduplicates message ids', async () => {
    const h = harness()
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
      streamUpdateIntervalMs: 0,
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ threadId: 'thread-1' }))
    await eventually(() => transport.updates.some(update => (update.card.config as any)?.summary?.content === '来自 dsh 的回答'))
    expect(h.creates).toHaveLength(1)
    expect(transport.cards).toHaveLength(1)
    expect(transport.cards[0]?.target.threadId).toBe('thread-1')
    expect(transport.cards[0]?.options).toEqual({ replyTo: 'message-1', replyInThread: true })
    expect(transport.cards[0]?.card).not.toHaveProperty('header')

    transport.emit(message({ messageId: 'message-2', threadId: 'thread-1', content: '继续' }))
    await eventually(() => h.agents[0]?.followed.length === 2)
    transport.emit(message({ messageId: 'message-2', threadId: 'thread-1', content: '重复' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.agents[0]?.followed).toHaveLength(2)
    expect([...h.state.tables.get('threads')!.values()]).toHaveLength(1)
  })

  it('creates a fresh Session for each unthreaded inbound message and adopts the reply thread', async () => {
    const h = harness()
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
      streamUpdateIntervalMs: 0,
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ messageId: 'first-unthreaded' }))
    await eventually(() => transport.updates.some(update => (update.card.config as any)?.summary?.content === '来自 dsh 的回答'))
    transport.emit(message({ messageId: 'second-unthreaded', content: '另一条首消息' }))
    await eventually(() => h.creates.length === 2)
    expect([...h.state.tables.get('threads')!.values()]).toHaveLength(2)
    expect(transport.cards[0]?.target.threadId).toBeUndefined()
    expect(transport.cards[0]?.options?.replyInThread).toBe(true)
  })

  it('keeps a first unthreaded Session serialized after the reply thread is established', async () => {
    let release!: () => void
    const turnGate = new Promise<void>((resolve) => { release = resolve })
    const h = harness(memoryState(), false, turnGate)
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ messageId: 'unthreaded-running' }))
    await eventually(() => h.agents[0]?.status === 'running' && transport.cards.length === 1)
    transport.emit(message({
      messageId: 'threaded-follow-up',
      threadId: 'reply-thread-card-main-1',
      content: '排队的问题',
    }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.agents[0]?.followed).toHaveLength(1)
    release()
  })

  it('recovers the Thread mapping after restart and resumes the same Session without replaying the old Turn', async () => {
    const state = memoryState()
    const first = harness(state)
    const firstGateway = await startFeishuGateway(first.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      first.transports.set(config.channelId, transport)
      return transport
    } })
    first.transports.get('main')!.emit(message({ threadId: 'thread-restart' }))
    await eventually(() => first.transports.get('main')!.updates.length > 0)
    await firstGateway.close()

    const second = harness(state)
    const secondGateway = await startFeishuGateway(second.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      second.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(secondGateway)
    const sessionId = first.creates[0]!
    const destination = secondGateway.resolveSessionTarget(sessionId)!
    await secondGateway.runScheduledTask({
      schedulerId: 'after-restart', instruction: 'scheduled followup', sessionId,
      channelId: destination.channelId, target: destination.target,
    })
    expect(second.transports.get('main')!.cards[0]?.options).toEqual({ replyTo: 'card-main-1', replyInThread: true })
    second.transports.get('main')!.emit(message({ messageId: 'message-after-restart', threadId: 'thread-restart' }))
    await eventually(() => second.agents[0]?.followed.length === 2)
    expect(second.resumes[0]).toBe(first.creates[0])
    expect(second.creates).toHaveLength(0)
  })

  it('does not replay an interrupted processing message after restart', async () => {
    const state = memoryState()
    const sessionId = SessionId('feishu-recover-session')
    const inbound = message({ messageId: 'recover-me', threadId: 'thread-recover' })
    state.persistedSessions.add(String(sessionId))
    state.tables.get('threads')!.set('main:thread-recover', {
      channelId: 'main',
      threadId: 'thread-recover',
      chatId: inbound.chatId,
      sessionId,
      workspace: '/tmp/dsh-lark-claw-test',
      updatedAt: Date.now(),
    })
    state.tables.get('messages')!.set('main:recover-me', {
      channelId: 'main',
      messageId: inbound.messageId,
      threadKey: 'main:thread-recover',
      sessionId,
      state: 'processing',
      updatedAt: Date.now(),
    })
    const h = harness(state)
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.resumes).toHaveLength(0)
    expect(h.agents).toHaveLength(0)
    expect(state.tables.get('messages')!.get('main:recover-me').state).toBe('processing')
  })

  it('executes Gateway commands without scheduling a model turn and sends proactive messages through the configured target', async () => {
    const h = harness()
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET', proactiveTarget: { chatId: 'proactive-chat', threadId: 'topic-1' } }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ content: '/help' }))
    await eventually(() => transport.texts.length === 1)
    expect(transport.texts[0]?.text).toContain('/reset')
    expect(h.agents[0]?.followed).toHaveLength(0)
    await gateway.sendProactive('定时通知')
    expect(transport.texts[1]).toMatchObject({ target: { chatId: 'proactive-chat', threadId: 'topic-1' }, text: '定时通知' })
  })

  it('dispatches a scheduled task through the same Session and Execution Card path', async () => {
    const h = harness()
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
      streamUpdateIntervalMs: 0,
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const result = await gateway.runScheduledTask({
      schedulerId: 'cron-1',
      instruction: '检查服务状态',
      sessionId: null,
      target: { chatId: 'cron-chat' },
      scheduleDescription: 'every 1 hour',
    })
    const transport = h.transports.get('main')!
    expect(result.sessionId).toBe(h.creates[0])
    expect(transport.cards[0]?.target).toEqual({ chatId: 'cron-chat' })
    expect(h.agents[0]?.followed[0]?.content[0]?.text).toContain('automatically triggered')
    expect(h.agents[0]?.followed[0]?.content[0]?.text).toContain('检查服务状态')
    expect(transport.updates.length).toBeGreaterThan(0)
  })

  it('admits images natively and saves other media to workspace uploads without saveFile', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-uploads-'))
    testWorkspaces.push(workspace)
    const h = harness(memoryState(), true)
    const gateway = await startFeishuGateway(h.ctx, {
      workspace,
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ resources: [
      { type: 'image', fileKey: 'image-key', fileName: 'photo.png' },
      { type: 'file', fileKey: 'file-key', fileName: 'report.pdf' },
      { type: 'audio', fileKey: 'audio-key' },
      { type: 'video', fileKey: 'video-key' },
    ] }))
    await eventually(() => h.agents[0]?.followed.length === 1)
    const content = h.agents[0]!.followed[0].content as readonly { type: string; text?: string }[]
    expect(content.map(block => block.type)).toEqual(['text', 'image', 'text', 'text', 'text'])
    expect(h.attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'photo.png' }))
    for (const [index, name, key] of [[2, 'report.pdf', 'file-key'], [3, 'audio-audio-key', 'audio-key'], [4, 'video-video-key', 'video-key']] as const) {
      const path = join(workspace, 'uploads', name)
      expect(content[index]?.text).toBe(`A new file message uploaded to \`${path}\``)
      expect(await readFile(path, 'utf8')).toBe(`downloaded:${key}`)
    }
  })

  it('keeps the user text and attachment failure in the model turn, then accepts a followup', async () => {
    const h = harness(memoryState(), true)
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: config => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    const download = vi.spyOn(transport, 'downloadResource')
      .mockRejectedValueOnce(new Error('Request failed with status code 400'))
    transport.emit(message({ threadId: 'topic', content: '你看得到这张图吗', resources: [
      { type: 'image', fileKey: 'broken-image' },
      { type: 'image', fileKey: 'good-image' },
    ] }))
    await eventually(() => h.agents[0]?.followed.length === 1)
    expect(download).toHaveBeenCalledWith('message-1', 'broken-image', 'image')
    const content = h.agents[0]!.followed[0].content
    expect(content[0]).toEqual({ type: 'text', text: '你看得到这张图吗' })
    expect(content[1].text).toContain('附件接入失败')
    expect(content[1].text).toContain('status code 400')
    expect(content[2].type).toBe('image')
    transport.emit(message({ messageId: 'followup', threadId: 'topic', content: '发生什么了' }))
    await eventually(() => h.agents[0]?.followed.length === 2)
    expect(h.agents).toHaveLength(1)
    expect(h.agents[0]!.followed[1].content[0].text).toBe('发生什么了')
  })

  it.each([false, true])('admits explicitly replied attachments and preserves lookup failures (%s)', async (fail) => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-reply-upload-'))
    testWorkspaces.push(workspace)
    const h = harness(memoryState(), true)
    const gateway = await startFeishuGateway(h.ctx, {
      workspace, channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: config => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    if (fail) transport.getMessageResources.mockRejectedValue(new Error('permission denied'))
    else transport.getMessageResources.mockResolvedValue([{ type: 'file', fileKey: 'parent-file', fileName: 'report.pdf' }])
    const download = vi.spyOn(transport, 'downloadResource')
    transport.emit(message({ content: '分析这个文件', replyToMessageId: 'parent', resources: [{ type: 'image', fileKey: 'own-image' }] }))
    await eventually(() => h.agents[0]?.followed.length === 1)
    expect(transport.getMessageResources).toHaveBeenCalledWith('parent', 'chat-1')
    expect(download).toHaveBeenCalledWith('message-1', 'own-image', 'image')
    const content = h.agents[0]!.followed[0].content
    expect(content[0].text).toBe('分析这个文件')
    if (fail) {
      expect(JSON.stringify(content)).toContain('permission denied')
      expect(download).not.toHaveBeenCalledWith('parent', expect.anything(), expect.anything())
    } else {
      expect(download).toHaveBeenCalledWith('parent', 'parent-file', 'file')
      expect(JSON.stringify(content)).toContain(join(workspace, 'uploads', 'report.pdf'))
      expect(await readFile(join(workspace, 'uploads', 'report.pdf'), 'utf8')).toBe('downloaded:parent-file')
    }
    transport.emit(message({ messageId: 'unquoted', threadId: 'other-topic', content: 'hello' }))
    await eventually(() => h.agents.reduce((n, a) => n + a.followed.length, 0) === 2)
    expect(transport.getMessageResources).toHaveBeenCalledTimes(1)
  })

  it('enforces source allowlists independently per Channel', async () => {
    const h = harness()
    const config: FeishuGatewayConfig = {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [
        { id: 'allowed', appId: 'cli_a', appSecretEnv: 'SECRET_A', groupAllowlist: ['group-ok'] },
        { id: 'direct-only', appId: 'cli_b', appSecretEnv: 'SECRET_B', dmMode: 'allowlist', dmAllowlist: ['user-ok'] },
      ],
      defaultChannelId: 'direct-only',
    }
    const gateway = await startFeishuGateway(h.ctx, config, { create: (channel) => {
      const transport = new FakeTransport(channel.channelId, channel)
      h.transports.set(channel.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    h.transports.get('allowed')!.emit(message({ chatType: 'group', chatId: 'group-denied' }))
    h.transports.get('direct-only')!.emit(message({ senderId: 'user-denied' }))
    await eventually(() => h.transports.get('allowed')!.texts.length === 1 && h.transports.get('direct-only')!.texts.length === 1)
    expect(h.agents).toHaveLength(0)
    expect(h.transports.get('allowed')!.texts[0]?.text).toContain('未获授权')
    expect(h.transports.get('direct-only')!.texts[0]?.text).toContain('未获授权')
  })

  it('sends the durable final answer as text when the final card update fails', async () => {
    const h = harness()
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
      streamUpdateIntervalMs: 0,
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      transport.failUpdates = true
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ threadId: 'thread-card-fallback' }))
    await eventually(() => transport.texts.length === 1)
    expect(transport.texts[0]?.text).toContain('来自 dsh 的回答')
    expect(h.agents[0]?.followed).toHaveLength(1)
  })

  it('dispatches /stop immediately for a running Turn instead of waiting behind the Thread queue', async () => {
    let release!: () => void
    const turnGate = new Promise<void>((resolve) => { release = resolve })
    const h = harness(memoryState(), false, turnGate)
    const gateway = await startFeishuGateway(h.ctx, {
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{ id: 'main', appId: 'cli_test', appSecretEnv: 'FEISHU_SECRET' }],
    }, { create: (config) => {
      const transport = new FakeTransport(config.channelId, config)
      h.transports.set(config.channelId, transport)
      return transport
    } })
    gateways.push(gateway)
    const transport = h.transports.get('main')!
    transport.emit(message({ messageId: 'long-running', threadId: 'thread-stop' }))
    await eventually(() => h.agents[0]?.status === 'running')
    transport.emit(message({ messageId: 'stop-now', threadId: 'thread-stop', content: '/stop' }))
    await eventually(() => transport.texts.length === 1)
    expect(transport.texts[0]?.text).toContain('已请求停止当前 Turn')
    expect(h.agents[0]?.followed).toHaveLength(1)
    release()
  })
})
