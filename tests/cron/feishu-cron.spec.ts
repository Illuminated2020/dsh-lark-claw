/* oxlint-disable typescript/no-explicit-any -- The fake KV context intentionally erases production-only Cordis/storage shapes. */
/* oxlint-disable typescript/no-unsafe-assignment -- Fake storage values are validated by the service under test. */
/* oxlint-disable typescript/no-unsafe-return -- Fake storage methods intentionally return erased values. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuCronService } from '../../src/cron/index.ts'
import type { FeishuGatewayService, FeishuTarget } from '../../src/gateway/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

interface State {
  readonly records: Map<string, any>
  route?: { path: string; handler: (...args: any[]) => any }
}

function testContext(state: State): Context {
  const context = {
    storageDomain: {
      open: async () => ({
        table: () => ({
          get: (key: string) => state.records.get(key),
          entries: () => state.records.entries(),
          keys: () => state.records.keys(),
          get size() { return state.records.size },
          put: async (key: string, value: unknown) => { state.records.set(key, value) },
          delete: async (key: string) => state.records.delete(key),
          update: async (key: string, fn: (value: any) => any) => {
            const next = fn(state.records.get(key))
            state.records.set(key, next)
            return next
          },
        }),
        close: async () => undefined,
      }),
    },
    webServer: {
      register: (route: { path: string; handler: (...args: any[]) => any }) => {
        state.route = route
        return () => undefined
      },
    },
    agents: { roots: () => [] },
    on: () => () => undefined,
    logger: { warn: vi.fn() },
  }
  return context as unknown as Context
}

function gateway(): FeishuGatewayService & { readonly runs: any[] } {
  const runs: any[] = []
  const target: FeishuTarget = { chatId: 'chat-1' }
  return {
    runs,
    resolveTarget: (channelId?: string, requested?: FeishuTarget) => ({
      channelId: channelId ?? 'main',
      target: requested ?? target,
    }),
    resolveSessionTarget: () => undefined,
    sendProactive: async () => undefined,
    runScheduledTask: async (request) => {
      runs.push(request)
      return { sessionId: request.sessionId ?? SessionId('scheduled-session'), messageId: 'card-1' }
    },
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('test condition did not settle')
}

const services: FeishuCronService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
})

describe('Feishu Cron', () => {
  it('persists a one-shot task and dispatches it through the Gateway', async () => {
    const state: State = { records: new Map<string, any>() }
    const targetGateway = gateway()
    const service = new FeishuCronService(testContext(state), {}, targetGateway)
    services.push(service)
    await service.start()

    const created = await service.scheduleTask({ instruction: '检查服务', schedule: { delay: 20 } })
    expect(created.nextRunAt).toBeGreaterThanOrEqual(Date.now())
    expect(service.listTasks()).toHaveLength(1)
    await eventually(() => targetGateway.runs.length === 1)
    expect(targetGateway.runs[0]).toMatchObject({ instruction: '检查服务', channelId: 'main', target: { chatId: 'chat-1' } })
    await eventually(() => service.listTasks().length === 0)
  })

  it('supports recurring patterns and API route ownership', async () => {
    const state: State = { records: new Map<string, any>() }
    const service = new FeishuCronService(testContext(state), { timezone: 'Asia/Shanghai' }, gateway())
    services.push(service)
    await service.start()
    expect(state.route?.path).toBe('/api/cronjobs')
    const created = await service.scheduleTask({ instruction: '日报', schedule: { pattern: '0 9 * * 1-5' } })
    expect(created.schedule.pattern).toBe('0 9 * * 1-5')
    expect(created.nextRunAt).toBeGreaterThan(Date.now())
    expect((await service.updateTask(created.id, { schedule: { every: 60_000 } }))?.schedule.every).toBe(60_000)
    expect(await service.removeTask(created.id)).toBe(true)
    expect(service.listTasks()).toHaveLength(0)
  })
})
