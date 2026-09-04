/** YAML configuration owned by dsh-lark-claw. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { FeishuGatewayConfig, FeishuChannelConfig } from '../gateway/types.ts'
import type { FeishuCronConfig } from '../cron/index.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-lark-claw-config'

/** The path may be supplied by the bundle patch; the default is `$DSH_HOME/config.yaml`. */
export interface DshLarkClawConfigPluginOptions {
  readonly path?: string
}

export const Config: z<DshLarkClawConfigPluginOptions> = z.object({
  path: z.string(),
})

/** Values consumed by the gateway, cron service, and control web server. */
export interface DshLarkClawConfig {
  readonly path: string
  readonly gateway: FeishuGatewayConfig
  readonly cron: FeishuCronConfig
  readonly server: {
    readonly host?: string
    readonly port?: number
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshLarkClawConfig: DshLarkClawConfig
  }
}

const channelParamsSchema = zod.record(zod.string(), zod.unknown()).default({})
const yamlChannelSchema = zod.object({
  id: zod.string().min(1),
  type: zod.string().min(1),
  name: zod.string().optional(),
  description: zod.string().optional(),
  params: channelParamsSchema,
}).strict()

const yamlConfigSchema = zod.object({
  timezone: zod.string().min(1).optional(),
  agents: zod.object({
    default: zod.object({
      type: zod.string().min(1).optional(),
      provider: zod.string().min(1).optional(),
      model: zod.string().min(1).optional(),
    }).strict(),
  }).strict().optional(),
  tasking: zod.object({
    max_retries: zod.number().int().nonnegative().optional(),
  }).strict().optional(),
  messaging: zod.object({
    default_channel_id: zod.string().min(1).optional(),
    channels: zod.array(yamlChannelSchema).min(1),
  }).strict().optional(),
  gateway: zod.object({
    workspace: zod.string().min(1).optional(),
    provider: zod.string().min(1).optional(),
    model: zod.string().min(1).optional(),
    stream_update_interval_ms: zod.number().int().nonnegative().optional(),
    card_markdown_limit: zod.number().int().positive().optional(),
  }).strict().optional(),
  cron: zod.object({
    concurrency: zod.number().int().positive().optional(),
    timezone: zod.string().min(1).optional(),
    api_token: zod.string().min(1).optional(),
  }).strict().optional(),
  server: zod.object({
    host: zod.string().min(1).optional(),
    port: zod.number().int().positive().optional(),
    api_token: zod.string().min(1).optional(),
  }).strict().optional(),
}).strict()

function dshHome(): string {
  return process.env.DSH_HOME === undefined || process.env.DSH_HOME === ''
    ? join(homedir(), '.dsh')
    : resolve(process.env.DSH_HOME)
}

/** Resolve `$ENV_NAME` scalar references in the YAML document. */
function resolveEnvironmentReferences(value: unknown, path = 'config'): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const name = value.slice(1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`${path} contains an invalid environment reference`)
    const resolved = process.env[name]
    if (resolved === undefined) throw new Error(`${path} references unset environment variable ${name}`)
    return resolved
  }
  if (Array.isArray(value)) return value.map((item, index) => resolveEnvironmentReferences(item, `${path}[${String(index)}]`))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      resolveEnvironmentReferences(item, `${path}.${key}`),
    ]))
  }
  return value
}

function stringParam(params: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = params[name]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function listParam(params: Record<string, unknown>, ...names: string[]): string[] | undefined {
  for (const name of names) {
    const value = params[name]
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [...value]
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
      } catch {
        return value.split(',').map(item => item.trim()).filter(Boolean)
      }
    }
  }
  return undefined
}

function booleanParam(params: Record<string, unknown>, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const value = params[name]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && value.trim() !== '') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes'].includes(normalized)) return true
      if (['false', '0', 'no'].includes(normalized)) return false
    }
  }
  return undefined
}

type YamlChannel = zod.infer<typeof yamlChannelSchema>

function channelFromYaml(channel: YamlChannel): FeishuChannelConfig {
  const params = channel.params
  const type = channel.type.toLowerCase()
  if (type !== 'feishu' && type !== 'lark') throw new Error(`dsh-lark-claw channel "${channel.id}" has unsupported type ${channel.type}`)
  const appId = stringParam(params, 'app_id', 'appId')
  const appSecret = stringParam(params, 'app_secret', 'appSecret')
  const appSecretEnv = stringParam(params, 'app_secret_env', 'appSecretEnv')
  if (appId === undefined) throw new Error(`dsh-lark-claw channel "${channel.id}" requires params.app_id`)
  if (appSecret === undefined && appSecretEnv === undefined) {
    throw new Error(`dsh-lark-claw channel "${channel.id}" requires params.app_secret or params.app_secret_env`)
  }
  if (appSecret !== undefined && appSecretEnv !== undefined) {
    throw new Error(`dsh-lark-claw channel "${channel.id}" cannot set both params.app_secret and params.app_secret_env`)
  }
  const chatId = stringParam(params, 'chat_id', 'chatId')
  const threadId = stringParam(params, 'thread_id', 'threadId')
  const groupAllowlist = listParam(params, 'group_allowlist', 'groupAllowlist')
  const dmAllowlist = listParam(params, 'dm_allowlist', 'dmAllowlist')
  const dmMode = stringParam(params, 'dm_mode', 'dmMode') as FeishuChannelConfig['dmMode'] | undefined
  const requireMention = booleanParam(params, 'require_mention', 'requireMention')
  if (dmMode !== undefined && !['open', 'allowlist', 'pair', 'disabled'].includes(dmMode)) {
    throw new Error(`dsh-lark-claw channel "${channel.id}" has unsupported dm_mode ${dmMode}`)
  }
  return {
    id: channel.id,
    appId,
    ...appSecret === undefined ? {} : { appSecret },
    ...appSecretEnv === undefined ? {} : { appSecretEnv },
    ...groupAllowlist === undefined ? {} : { groupAllowlist },
    ...dmAllowlist === undefined ? {} : { dmAllowlist },
    ...dmMode === undefined ? {} : { dmMode },
    ...requireMention === undefined ? {} : { requireMention },
    ...chatId === undefined ? {} : { proactiveTarget: { chatId, ...threadId === undefined ? {} : { threadId } } },
  }
}

function envChannels(): FeishuChannelConfig[] {
  const raw = process.env.FEISHU_CHANNELS ?? process.env.DSH_FEISHU_CHANNELS
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new Error(`dsh-lark-claw FEISHU_CHANNELS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('dsh-lark-claw FEISHU_CHANNELS must be a JSON array')
  return parsed.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`dsh-lark-claw FEISHU_CHANNELS[${String(index)}] must be an object`)
    const channel = item as Record<string, unknown>
    if (typeof channel.id !== 'string' || typeof channel.appId !== 'string' || typeof channel.appSecretEnv !== 'string') {
      throw new Error(`dsh-lark-claw FEISHU_CHANNELS[${String(index)}] requires id, appId, and appSecretEnv`)
    }
    return channel as unknown as FeishuChannelConfig
  })
}

function fromEnvironment(path: string): DshLarkClawConfig {
  const workspace = process.env.FEISHU_WORKSPACE ?? process.env.DSH_FEISHU_WORKSPACE ?? process.cwd()
  const provider = process.env.FEISHU_PROVIDER ?? process.env.DSH_FEISHU_PROVIDER
  const model = process.env.FEISHU_MODEL ?? process.env.DSH_FEISHU_MODEL
  const streamUpdateIntervalMs = process.env.FEISHU_STREAM_UPDATE_INTERVAL_MS ?? process.env.DSH_FEISHU_STREAM_UPDATE_INTERVAL_MS
  const cardMarkdownLimit = process.env.FEISHU_CARD_MARKDOWN_LIMIT ?? process.env.DSH_FEISHU_CARD_MARKDOWN_LIMIT
  const concurrency = process.env.FEISHU_CRON_CONCURRENCY ?? process.env.DSH_FEISHU_CRON_CONCURRENCY
  const port = process.env.FEISHU_CONTROL_PORT
  const timezone = process.env.FEISHU_CRON_TIMEZONE ?? process.env.DSH_FEISHU_CRON_TIMEZONE
  const apiToken = process.env.FEISHU_CRON_API_TOKEN ?? process.env.DSH_FEISHU_CRON_API_TOKEN
  const host = process.env.FEISHU_CONTROL_HOST
  return {
    path,
    gateway: {
      workspace,
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      channels: envChannels(),
      ...streamUpdateIntervalMs === undefined ? {} : { streamUpdateIntervalMs: Number(streamUpdateIntervalMs) },
      ...cardMarkdownLimit === undefined ? {} : { cardMarkdownLimit: Number(cardMarkdownLimit) },
    },
    cron: {
      ...concurrency === undefined ? {} : { concurrency: Number(concurrency) },
      ...timezone === undefined ? {} : { timezone },
      ...apiToken === undefined ? {} : { apiToken },
    },
    server: {
      ...host === undefined ? {} : { host },
      ...port === undefined ? {} : { port: Number(port) },
    },
  }
}

function fromYaml(path: string, input: unknown): DshLarkClawConfig {
  const parsed = yamlConfigSchema.parse(resolveEnvironmentReferences(input))
  const channels = parsed.messaging?.channels.map(channelFromYaml) ?? []
  if (channels.length === 0) throw new Error('dsh-lark-claw config.yaml requires messaging.channels')
  const gateway = parsed.gateway
  const defaultAgent = parsed.agents?.default
  const workspace = gateway?.workspace ?? process.env.FEISHU_WORKSPACE ?? process.env.DSH_FEISHU_WORKSPACE ?? process.cwd()
  const provider = gateway?.provider ?? defaultAgent?.provider ?? process.env.FEISHU_PROVIDER ?? process.env.DSH_FEISHU_PROVIDER
  const model = gateway?.model ?? defaultAgent?.model ?? process.env.FEISHU_MODEL ?? process.env.DSH_FEISHU_MODEL
  const cron = parsed.cron
  const cronTimezone = cron?.timezone ?? parsed.timezone
  const apiToken = cron?.api_token ?? parsed.server?.api_token
  return {
    path,
    gateway: {
      workspace: resolve(workspace),
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      channels,
      ...parsed.messaging?.default_channel_id === undefined ? {} : { defaultChannelId: parsed.messaging.default_channel_id },
      ...gateway?.stream_update_interval_ms === undefined ? {} : { streamUpdateIntervalMs: gateway.stream_update_interval_ms },
      ...gateway?.card_markdown_limit === undefined ? {} : { cardMarkdownLimit: gateway.card_markdown_limit },
    },
    cron: {
      ...cron?.concurrency === undefined ? {} : { concurrency: cron.concurrency },
      ...cronTimezone === undefined ? {} : { timezone: cronTimezone },
      ...apiToken === undefined ? {} : { apiToken },
    },
    server: {
      ...parsed.server?.host === undefined ? {} : { host: parsed.server.host },
      ...parsed.server?.port === undefined ? {} : { port: parsed.server.port },
    },
  }
}

/** Load the plugin's YAML file, falling back to the legacy environment contract when absent. */
export async function loadDshLarkClawConfig(path?: string): Promise<DshLarkClawConfig> {
  const configPath = resolve(path ?? process.env.DSH_LARK_CLAW_CONFIG ?? join(dshHome(), 'config.yaml'))
  try {
    const text = await readFile(configPath, 'utf8')
    let parsed: unknown
    try {
      parsed = parseYaml(text)
    } catch (error: unknown) {
      throw new Error(`dsh-lark-claw cannot parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return fromYaml(configPath, parsed)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return fromEnvironment(configPath)
  }
}

/** Cordis entry point. */
export async function apply(ctx: Context, config: DshLarkClawConfigPluginOptions): Promise<void> {
  ctx.provide('dshLarkClawConfig', await loadDshLarkClawConfig(config.path))
}
