/**
 * Persistent Feishu scheduled tasks.
 *
 * This package deliberately owns timing and task records. The Feishu Gateway
 * remains the replaceable delivery/session adapter, so another scheduler can
 * consume the same service without changing dsh core or the Gateway protocol.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { FeishuGatewayService, FeishuTarget } from '../gateway/index.ts'
import type {} from '../gateway/index.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z as zod } from 'zod'

export const name = 'feishu-cron'
export const inject = ['agents', 'feishuGateway', 'storageDomain', 'tools', 'webServer']

export interface FeishuCronConfig {
  /** Maximum number of distinct scheduled turns executed concurrently. */
  readonly concurrency?: number
  /** IANA timezone used by cron patterns when a schedule omits one. */
  readonly timezone?: string
  /** Optional bearer token for the management API. */
  readonly apiToken?: string
}

export const Config: z<FeishuCronConfig> = z.object({
  concurrency: z.number().step(1).min(1).default(4),
  timezone: z.string(),
  apiToken: z.string().role('secret'),
})

export type FeishuTaskSchedule = {
  /** Absolute Unix timestamp in milliseconds; one-shot selector. */
  readonly at?: number | undefined
  /** Delay in milliseconds from creation; one-shot selector. */
  readonly delay?: number | undefined
  /** Five-field cron expression; recurring selector. */
  readonly pattern?: string | undefined
  /** Fixed interval in milliseconds; recurring selector. */
  readonly every?: number | undefined
  /** Maximum number of recurring executions. */
  readonly limit?: number | undefined
  /** Run the first recurring occurrence immediately. */
  readonly immediately?: boolean | undefined
  /** IANA timezone for a pattern. */
  readonly timezone?: string | undefined
}

/** JSON-facing target shape; the optional field is explicit for strict TS consumers. */
export interface FeishuCronTarget {
  readonly chatId: string
  readonly threadId?: string | undefined
}

export interface FeishuCronRecord {
  readonly id: string
  readonly sessionId: SessionId | null
  readonly instruction: string
  readonly schedule: FeishuTaskSchedule
  readonly channelId: string
  readonly target: FeishuCronTarget
  readonly nextAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly runCount: number
  readonly lastRunAt?: number | undefined
  readonly lastError?: string | undefined
}

export interface FeishuCronJobView {
  readonly id: string
  readonly sessionId: SessionId | null
  readonly instruction: string
  readonly schedule: FeishuTaskSchedule
  readonly channelId: string
  readonly target: FeishuCronTarget
  readonly nextRunAt: number
  readonly runCount: number
  readonly lastRunAt?: number | undefined
  readonly lastError?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

export interface FeishuCronCreateRequest {
  readonly instruction: string
  readonly schedule: FeishuTaskSchedule
  readonly sessionId?: SessionId | null
  readonly channelId?: string
  readonly target?: FeishuCronTarget
}

export interface FeishuCronUpdateRequest {
  readonly instruction?: string
  readonly schedule?: FeishuTaskSchedule
  readonly sessionId?: SessionId | null
  readonly channelId?: string
  readonly target?: FeishuCronTarget
}

const sessionIdSchema = zod.string().min(1).transform(value => SessionId(value))
const targetSchema = zod.object({
  chatId: zod.string().min(1),
  threadId: zod.string().min(1).optional(),
})
const scheduleSchema = zod.object({
  at: zod.number().int().positive().optional(),
  delay: zod.number().int().nonnegative().optional(),
  pattern: zod.string().min(1).optional(),
  every: zod.number().int().positive().optional(),
  limit: zod.number().int().positive().optional(),
  immediately: zod.boolean().optional(),
  timezone: zod.string().min(1).optional(),
}).strict()
const cronRecordSchema = zod.object({
  id: zod.string().min(1),
  sessionId: sessionIdSchema.nullable(),
  instruction: zod.string().min(1),
  schedule: scheduleSchema,
  channelId: zod.string().min(1),
  target: targetSchema,
  nextAt: zod.number().int().nonnegative(),
  createdAt: zod.number().int().nonnegative(),
  updatedAt: zod.number().int().nonnegative(),
  runCount: zod.number().int().nonnegative(),
  lastRunAt: zod.number().int().nonnegative().optional(),
  lastError: zod.string().optional(),
})

const feishuCronDomainSpec = defineDomain({
  name: 'feishu_cron',
  version: 1,
  tables: {
    schedules: domainTable<string, FeishuCronRecord>(cronRecordSchema),
  },
})
type FeishuCronDomain = Domain<typeof feishuCronDomainSpec>

interface CronField {
  readonly values: ReadonlySet<number>
  readonly any: boolean
}

interface CronPattern {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

const MAX_TIMER_DELAY = 2_147_000_000
const MAX_CRON_LOOKAHEAD_MINUTES = 366 * 24 * 60

function field(text: string, min: number, max: number, normalize = (value: number): number => value): CronField {
  const values = new Set<number>()
  const any = text === '*'
  for (const rawPart of text.split(',')) {
    if (rawPart === '') throw new Error('cron pattern contains an empty field')
    const [rawRange, rawStep] = rawPart.split('/')
    const step = rawStep === undefined ? 1 : Number(rawStep)
    if (!Number.isSafeInteger(step) || step < 1) throw new Error('cron pattern step must be a positive integer')
    const range = rawRange === '*' ? `${min}-${max}` : rawRange ?? ''
    const rangeParts = range.split('-')
    const rawStart = rangeParts[0] ?? ''
    const rawEnd = rangeParts[1] ?? rawStart
    const start = Number(rawStart)
    const end = Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
      throw new Error(`cron pattern value must be between ${String(min)} and ${String(max)}`)
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }
  if (values.size === 0) throw new Error('cron pattern field is empty')
  return { values, any }
}

function parsePattern(pattern: string): CronPattern {
  const parts = pattern.trim().split(/\s+/u)
  if (parts.length !== 5) throw new Error('cron pattern must contain five fields: minute hour day-of-month month day-of-week')
  const part = (index: number): string => {
    const value = parts[index]
    if (value === undefined) throw new Error('cron pattern is incomplete')
    return value
  }
  return {
    minute: field(part(0), 0, 59),
    hour: field(part(1), 0, 23),
    dayOfMonth: field(part(2), 1, 31),
    month: field(part(3), 1, 12),
    dayOfWeek: field(part(4), 0, 7, value => value === 7 ? 0 : value),
  }
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const values = new Map<string, number>()
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') values.set(part.type, Number(part.value))
  }
  const value = (name: string): number => {
    const result = values.get(name)
    if (result === undefined) throw new Error(`timezone formatter omitted ${name}`)
    return result
  }
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') }
}

function matchesDay(pattern: CronPattern, parts: ReturnType<typeof zonedParts>): boolean {
  const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  const dom = pattern.dayOfMonth.values.has(parts.day)
  const dow = pattern.dayOfWeek.values.has(dayOfWeek)
  if (pattern.dayOfMonth.any && pattern.dayOfWeek.any) return true
  if (pattern.dayOfMonth.any) return dow
  if (pattern.dayOfWeek.any) return dom
  return dom || dow
}

function nextPattern(patternText: string, after: number, timezone: string): number {
  const pattern = parsePattern(patternText)
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000
  for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i += 1) {
    const parts = zonedParts(new Date(candidate), timezone)
    if (pattern.minute.values.has(parts.minute)
      && pattern.hour.values.has(parts.hour)
      && pattern.month.values.has(parts.month)
      && matchesDay(pattern, parts)) return candidate
    candidate += 60_000
  }
  throw new Error('cron pattern has no occurrence in the next year')
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new Error(`unknown IANA timezone "${timezone}"`)
  }
}

function defaultTimezone(configured?: string): string {
  const timezone = configured ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  validateTimezone(timezone)
  return timezone
}

function validateSchedule(input: FeishuTaskSchedule, now: number, configuredTimezone?: string): FeishuTaskSchedule {
  const oneShot = Number(input.at !== undefined) + Number(input.delay !== undefined)
  const recurring = Number(input.pattern !== undefined) + Number(input.every !== undefined)
  if (oneShot + recurring !== 1) throw new Error('schedule requires exactly one of at, delay, pattern, or every')
  if (input.immediately === true && oneShot !== 0) throw new Error('immediately is only valid for recurring schedules')
  if (input.at !== undefined && (!Number.isSafeInteger(input.at) || input.at <= now)) throw new Error('at must be a future Unix timestamp in milliseconds')
  if (input.delay !== undefined && (!Number.isSafeInteger(input.delay) || input.delay < 0)) throw new Error('delay must be a non-negative safe integer in milliseconds')
  if (input.every !== undefined && (!Number.isSafeInteger(input.every) || input.every < 1_000)) throw new Error('every must be at least 1000 milliseconds')
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new Error('limit must be a positive safe integer')
  if (input.pattern !== undefined) parsePattern(input.pattern)
  const timezone = input.timezone ?? configuredTimezone
  if (timezone !== undefined) validateTimezone(timezone)
  return { ...input, ...timezone === undefined ? {} : { timezone } }
}

function nextAtFor(schedule: FeishuTaskSchedule, now: number): number {
  if (schedule.at !== undefined) return schedule.at
  if (schedule.delay !== undefined) return now + schedule.delay
  if (schedule.immediately === true) return now
  if (schedule.every !== undefined) return now + schedule.every
  return nextPattern(requirePattern(schedule), now, schedule.timezone ?? defaultTimezone())
}

function nextRecurringAt(schedule: FeishuTaskSchedule, dueAt: number, now: number): number {
  if (schedule.every !== undefined) {
    let next = dueAt + schedule.every
    while (next <= now) next += schedule.every
    return next
  }
  return nextPattern(requirePattern(schedule), now, schedule.timezone ?? defaultTimezone())
}

function requirePattern(schedule: FeishuTaskSchedule): string {
  if (schedule.pattern === undefined) throw new Error('recurring schedule pattern is missing')
  return schedule.pattern
}

function scheduleDescription(schedule: FeishuTaskSchedule): string {
  if (schedule.pattern !== undefined) return `cron ${schedule.pattern}${schedule.timezone === undefined ? '' : ` (${schedule.timezone})`}`
  if (schedule.every !== undefined) return `every ${String(schedule.every)} ms`
  if (schedule.at !== undefined) return `at ${new Date(schedule.at).toISOString()}`
  return `after ${String(schedule.delay)} ms`
}

function gatewayTarget(target: FeishuCronTarget): FeishuTarget {
  return target.threadId === undefined ? { chatId: target.chatId } : target as FeishuTarget
}

function view(record: FeishuCronRecord): FeishuCronJobView {
  return {
    id: record.id,
    sessionId: record.sessionId,
    instruction: record.instruction,
    schedule: record.schedule,
    channelId: record.channelId,
    target: record.target,
    nextRunAt: record.nextAt,
    runCount: record.runCount,
    ...record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt },
    ...record.lastError === undefined ? {} : { lastError: record.lastError },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of req) {
    const bytes: Uint8Array = typeof chunk === 'string'
      ? new TextEncoder().encode(chunk)
      : new Uint8Array(chunk as ArrayBufferLike)
    length += bytes.length
    if (length > 1_048_576) throw new Error('request body is too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  return JSON.parse(text)
}

function bearerAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined || token === '') return true
  const authorization = req.headers.authorization
  return authorization === `Bearer ${token}` || req.headers['x-feishu-cron-token'] === token
}

function renderToolValue(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Feishu scheduled-task service: durable definitions + timer driver + API. */
export class FeishuCronService {
  private readonly concurrency: number
  private readonly timezone: string
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queued: string[] = []
  private readonly queuedSet = new Set<string>()
  private readonly running = new Set<string>()
  private readonly runningTasks = new Set<Promise<void>>()
  private readonly toolDisposers: Array<() => void> = []
  private domain: FeishuCronDomain | undefined
  private routeDisposer: (() => void) | undefined
  private stopCreated: (() => void) | undefined
  private closing = false
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly config: FeishuCronConfig,
    private readonly gateway: FeishuGatewayService,
  ) {
    this.concurrency = config.concurrency ?? 4
    this.timezone = defaultTimezone(config.timezone)
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.closing) throw new Error('feishu-cron has already been closed')
    if (this.ctx.webServer.host === '0.0.0.0' && (this.config.apiToken === undefined || this.config.apiToken === '')) {
      throw new Error('feishu-cron apiToken is required when the control web server listens on all interfaces')
    }
    this.domain = await this.ctx.storageDomain.open(feishuCronDomainSpec)
    try {
      this.routeDisposer = this.ctx.webServer.register({
        kind: 'prefix',
        path: '/api/cronjobs',
        handler: (req, res) => this.handleRequest(req, res),
      } satisfies WebRoute)
      this.stopCreated = this.ctx.on('agent/created', ({ agent }) => {
        if (this.ctx.agents.roots().includes(agent)) this.installTools(agent)
      })
      for (const agent of this.ctx.agents.roots()) this.installTools(agent)
      for (const record of this.table().entries()) this.arm(record[1])
      this.started = true
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.stopCreated?.()
    this.stopCreated = undefined
    this.routeDisposer?.()
    this.routeDisposer = undefined
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.queued.length = 0
    this.queuedSet.clear()
    for (const dispose of this.toolDisposers.splice(0)) dispose()
    const drain = Promise.allSettled(this.runningTasks).then(async () => {
      await this.domain?.close()
      this.domain = undefined
    })
    if (this.runningTasks.size === 0) await drain
    else void drain
  }

  async scheduleTask(request: FeishuCronCreateRequest): Promise<FeishuCronJobView> {
    const table = this.table()
    const now = Date.now()
    const schedule = validateSchedule(request.schedule, now, this.timezone)
    const sessionTarget = request.sessionId === null || request.sessionId === undefined || request.target !== undefined
      ? undefined
      : this.gateway.resolveSessionTarget(request.sessionId)
    const resolved = this.gateway.resolveTarget(
      request.channelId ?? sessionTarget?.channelId,
      request.target === undefined ? sessionTarget?.target : gatewayTarget(request.target),
    )
    const record: FeishuCronRecord = {
      id: randomUUID(),
      sessionId: request.sessionId ?? null,
      instruction: requireInstruction(request.instruction),
      schedule,
      channelId: resolved.channelId,
      target: resolved.target,
      nextAt: nextAtFor(schedule, now),
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    }
    await table.put(record.id, record)
    this.arm(record)
    return view(record)
  }

  async updateTask(id: string, request: FeishuCronUpdateRequest): Promise<FeishuCronJobView | undefined> {
    const current = this.table().get(id)
    if (current === undefined) return undefined
    const now = Date.now()
    const schedule = validateSchedule(request.schedule ?? current.schedule, now, this.timezone)
    const target = request.target ?? current.target
    const resolved = this.gateway.resolveTarget(request.channelId ?? current.channelId, gatewayTarget(target))
    const next: FeishuCronRecord = {
      ...current,
      instruction: request.instruction === undefined ? current.instruction : requireInstruction(request.instruction),
      sessionId: request.sessionId === undefined ? current.sessionId : request.sessionId,
      schedule,
      channelId: resolved.channelId,
      target: resolved.target,
      nextAt: nextAtFor(schedule, now),
      updatedAt: now,
      runCount: 0,
    }
    this.clearTimer(id)
    await this.table().put(id, next)
    this.arm(next)
    return view(next)
  }

  async removeTask(id: string): Promise<boolean> {
    this.clearTimer(id)
    this.queuedSet.delete(id)
    const at = this.queued.indexOf(id)
    if (at !== -1) this.queued.splice(at, 1)
    return this.table().delete(id)
  }

  listTasks(): FeishuCronJobView[] {
    return [...this.table().entries()]
      .map(([, record]) => view(record))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  private table() {
    if (this.domain === undefined) throw new Error('feishu-cron state is not open')
    return this.domain.table('schedules')
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(id)
  }

  private arm(record: FeishuCronRecord): void {
    if (this.closing) return
    this.clearTimer(record.id)
    const delay = Math.max(0, record.nextAt - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(record.id)
      const latest = this.table().get(record.id)
      if (latest === undefined) return
      if (latest.nextAt > Date.now()) {
        this.arm(latest)
        return
      }
      this.enqueue(record.id)
    }, Math.min(delay, MAX_TIMER_DELAY))
    this.timers.set(record.id, timer)
  }

  private enqueue(id: string): void {
    if (this.closing || this.queuedSet.has(id) || this.running.has(id)) return
    this.queuedSet.add(id)
    this.queued.push(id)
    this.pump()
  }

  private pump(): void {
    while (!this.closing && this.running.size < this.concurrency && this.queued.length > 0) {
      const id = this.queued.shift()
      if (id === undefined) break
      this.queuedSet.delete(id)
      const record = this.table().get(id)
      if (record === undefined) continue
      this.running.add(id)
      const task = this.execute(id, record).catch((error: unknown) => {
        this.ctx.logger.warn(`feishu-cron task ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => {
        this.running.delete(id)
        this.runningTasks.delete(task)
        this.pump()
      })
      this.runningTasks.add(task)
    }
  }

  private async execute(id: string, record: FeishuCronRecord): Promise<void> {
    let errorText: string | undefined
    try {
      await this.gateway.runScheduledTask({
        schedulerId: record.id,
        instruction: record.instruction,
        sessionId: record.sessionId,
        channelId: record.channelId,
        target: gatewayTarget(record.target),
        scheduleDescription: scheduleDescription(record.schedule),
      })
    } catch (error: unknown) {
      errorText = error instanceof Error ? error.message : String(error)
    }
    const latest = this.table().get(id)
    if (latest === undefined) return
    if (latest.schedule.at !== undefined || latest.schedule.delay !== undefined) {
      await this.table().delete(id)
      if (errorText !== undefined) this.ctx.logger.warn(`feishu-cron one-shot ${id} failed: ${errorText}`)
      return
    }
    const runCount = record.runCount + 1
    if (latest.schedule.limit !== undefined && runCount >= latest.schedule.limit) {
      await this.table().delete(id)
      return
    }
    const now = Date.now()
    const next: FeishuCronRecord = {
      ...latest,
      nextAt: nextRecurringAt(latest.schedule, record.nextAt, now),
      runCount,
      lastRunAt: now,
      updatedAt: now,
      ...errorText === undefined ? {} : { lastError: errorText },
    }
    await this.table().put(id, next)
    this.arm(next)
  }

  private installTools(agent: Agent): void {
    if (this.closing) return
    const dispose = agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.tools.register(defineTool({
          name: 'cron_create',
          description: 'Create a persistent Feishu scheduled task. Use exactly one of at, after_seconds, every_seconds, or pattern; the task runs in Feishu and survives process restarts.',
          parameters: {
            instruction: { type: 'string', required: true, description: 'Instruction to execute when triggered.' },
            at: { type: 'string', description: 'One-shot ISO 8601 timestamp in the future.' },
            after_seconds: { type: 'number', description: 'One-shot delay in seconds.' },
            every_seconds: { type: 'number', description: 'Recurring fixed interval in seconds.' },
            pattern: { type: 'string', description: 'Five-field cron expression, for example 0 9 * * 1-5.' },
            limit: { type: 'number', description: 'Maximum recurring executions.' },
            session_mode: { type: 'string', enum: ['current', 'independent'], description: 'Reuse this Feishu conversation or start a fresh Session.' },
          },
          output: { schema: { type: 'string' } as const, render: renderToolValue },
          execute: async (args, exec) => {
            const selectors = Number(args.at !== undefined)
              + Number(args.after_seconds !== undefined)
              + Number(args.every_seconds !== undefined)
              + Number(args.pattern !== undefined)
            if (selectors !== 1) return JSON.stringify({ error: 'use exactly one schedule selector' })
            const schedule: FeishuTaskSchedule = args.at !== undefined
              ? { at: requireAt(args.at) }
              : args.after_seconds !== undefined
                ? { delay: requireSeconds(args.after_seconds) * 1000 }
                : args.every_seconds !== undefined
                  ? { every: requireSeconds(args.every_seconds) * 1000, limit: args.limit }
                  : { pattern: args.pattern, limit: args.limit }
            const created = await this.scheduleTask({
              instruction: args.instruction,
              schedule,
              sessionId: args.session_mode === 'independent' ? null : exec.agent?.session.id ?? null,
            })
            return JSON.stringify({ ...created, deliveryMode: created.sessionId === null ? 'independent' : 'session-contextual' })
          },
          presentCall: args => ({ card: 'generic', title: 'Create Feishu cronjob', kind: 'other', rawInput: args.instruction }),
        })),
        agent.ctx.tools.register(defineTool({
          name: 'cron_list',
          description: 'List persistent Feishu scheduled tasks and their next run times.',
          parameters: {},
          output: { schema: { type: 'string' } as const, render: renderToolValue },
          execute: (_args, _exec) => Promise.resolve(JSON.stringify(this.listTasks())),
          presentCall: () => ({ card: 'generic', title: 'List Feishu cronjobs', kind: 'read' }),
        })),
        agent.ctx.tools.register(defineTool({
          name: 'cron_delete',
          description: 'Delete a persistent Feishu scheduled task by its exact id.',
          parameters: { id: { type: 'string', required: true } },
          output: { schema: { type: 'string' } as const, render: renderToolValue },
          execute: async args => JSON.stringify({ id: args.id, deleted: await this.removeTask(args.id) }),
          presentCall: args => ({ card: 'generic', title: 'Delete Feishu cronjob', kind: 'other', rawInput: args.id }),
        })),
      ]
      return () => { for (const disposer of disposers) disposer() }
    }, `feishu-cron.tools(${String(agent.id)})`)
    this.toolDisposers.push(() => { void dispose() })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerAuthorized(req, this.config.apiToken)) {
      jsonResponse(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const suffix = pathname.slice('/api/cronjobs'.length).replace(/^\//u, '')
      if (req.method === 'GET' && suffix === '') {
        jsonResponse(res, 200, this.listTasks())
        return
      }
      if (req.method === 'POST' && suffix === '') {
        const input = parseCreate(await requestBody(req))
        const created = await this.scheduleTask(input)
        jsonResponse(res, 201, created)
        return
      }
      if (suffix === '') {
        jsonResponse(res, 405, { error: 'method_not_allowed' })
        return
      }
      const id = decodeURIComponent(suffix)
      if (id.includes('/')) {
        jsonResponse(res, 404, { error: 'not_found' })
        return
      }
      if (req.method === 'DELETE') {
        jsonResponse(res, 200, { id, deleted: await this.removeTask(id) })
        return
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const updated = await this.updateTask(id, parseUpdate(await requestBody(req)))
        if (updated === undefined) jsonResponse(res, 404, { error: 'not_found' })
        else jsonResponse(res, 200, updated)
        return
      }
      jsonResponse(res, 405, { error: 'method_not_allowed' })
    } catch (error: unknown) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function requireInstruction(value: string): string {
  if (value.trim() === '') throw new Error('instruction must be non-empty')
  return value
}

function requireSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('seconds must be a positive safe integer')
  return value
}

function requireAt(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp <= Date.now()) throw new Error('at must be a future ISO 8601 timestamp')
  return timestamp
}

function parseCreate(value: unknown): FeishuCronCreateRequest {
  const parsed = zod.object({
    instruction: zod.string().min(1),
    schedule: scheduleSchema,
    session_id: sessionIdSchema.nullable().optional(),
    channel_id: zod.string().min(1).optional(),
    target: targetSchema.optional(),
  }).strict().parse(value)
  return {
    instruction: parsed.instruction,
    schedule: parsed.schedule,
    ...parsed.session_id === undefined ? {} : { sessionId: parsed.session_id },
    ...parsed.channel_id === undefined ? {} : { channelId: parsed.channel_id },
    ...parsed.target === undefined ? {} : { target: parsed.target },
  }
}

function parseUpdate(value: unknown): FeishuCronUpdateRequest {
  const parsed = zod.object({
    instruction: zod.string().min(1).optional(),
    schedule: scheduleSchema.optional(),
    session_id: sessionIdSchema.nullable().optional(),
    channel_id: zod.string().min(1).optional(),
    target: targetSchema.optional(),
  }).strict().parse(value)
  return {
    ...parsed.instruction === undefined ? {} : { instruction: parsed.instruction },
    ...parsed.schedule === undefined ? {} : { schedule: parsed.schedule },
    ...parsed.session_id === undefined ? {} : { sessionId: parsed.session_id },
    ...parsed.channel_id === undefined ? {} : { channelId: parsed.channel_id },
    ...parsed.target === undefined ? {} : { target: parsed.target },
  }
}

export async function apply(ctx: Context, config: FeishuCronConfig): Promise<void> {
  const gateway = ctx.feishuGateway
  const service = new FeishuCronService(ctx, config, gateway)
  ctx.effect(() => () => service.close(), 'feishu-cron.lifecycle()')
  await service.start()
  ctx.provide('feishuCron', service)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishuCron: FeishuCronService
  }
}

export { feishuCronDomainSpec }
