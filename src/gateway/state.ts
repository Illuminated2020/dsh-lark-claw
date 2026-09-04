/** Durable Gateway State declaration. Session history remains dsh JSONL. */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { FeishuChannelRecord, FeishuMessageRecord, FeishuThreadRecord } from './types.ts'

const sessionId = z.string().min(1).transform(value => SessionId(value))

const channelRecord = z.object({
  channelId: z.string().min(1),
  appId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
})

const threadRecord = z.object({
  channelId: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  sessionId,
  workspace: z.string().min(1),
  cardMessageId: z.string().min(1).optional(),
  updatedAt: z.number().int().nonnegative(),
})

const messageRecord = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  threadKey: z.string().min(1),
  sessionId,
  state: z.enum(['processing', 'completed', 'rejected']),
  updatedAt: z.number().int().nonnegative(),
})

/** The one Gateway-owned state domain. */
export const feishuGatewayDomainSpec = defineDomain({
  name: 'feishu_gateway',
  version: 1,
  tables: {
    channels: domainTable<string, FeishuChannelRecord>(channelRecord),
    threads: domainTable<string, FeishuThreadRecord>(threadRecord),
    messages: domainTable<string, FeishuMessageRecord>(messageRecord),
  },
})

/** Type of the Gateway State domain handle. */
export type FeishuGatewayDomain = typeof feishuGatewayDomainSpec
