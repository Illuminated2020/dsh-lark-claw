import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalService, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionService, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuInteractions, parseAnswers, questionCard } from '../../src/gateway/interactions.ts'
import type { FeishuCardAction, FeishuTransport } from '../../src/gateway/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })

function setup() {
  const ctx = new Context()
  // Only the session read surface is needed by this answerer; dispatch is real Cordis.
  const session = Session.create(SessionId('interaction-test'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: 'agent-test', session } as unknown as Agent
  const sendCard = vi.fn<FeishuTransport['sendCard']>().mockResolvedValue({ messageId: 'interaction' })
  const updateCard = vi.fn<FeishuTransport['updateCard']>().mockResolvedValue(undefined)
  const transport = { channelId: 'main', sendCard, updateCard } as unknown as FeishuTransport
  const waiting = vi.fn()
  const bridge = new FeishuInteractions(ctx, 1000)
  const dispose = bridge.bind({ agent, transport, target: { chatId: 'chat', threadId: 'topic' }, anchor: 'execution', userId: 'owner', waiting })
  cleanups.push(dispose, () => bridge.close())
  const approval = (extra: Partial<ApprovalRequest> = {}) => ctx.waterfall('approval/request', {
    agent, toolName: 'bash', reason: 'Write outside workspace', ...extra,
  }, () => Promise.resolve('unavailable' as const))
  const questions = (extra: Partial<AskUserQuestionRequest> = {}) => ctx.waterfall('user-questions/request', {
    agent, questions: [{ id: 'q1', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }], ...extra,
  }, () => Promise.reject(new Error('no answerer')))
  async function action(value: object = { decision: 'allow' }): Promise<FeishuCardAction> {
    await vi.waitFor(() => expect(sendCard).toHaveBeenCalled())
    await Promise.resolve()
    const match = JSON.stringify(sendCard.mock.calls[0]![1]).match(/"requestId":"([^"]+)"/)
    return { messageId: 'interaction', chatId: 'chat', userId: 'owner', value: { requestId: match![1], ...value } }
  }
  return { ctx, agent, approval, questions, bridge, sendCard, updateCard, waiting, action, dispose }
}

describe('Feishu human interactions', () => {
  it.each([['allow', 'allowed-once'], ['reject', 'rejected']])('returns %s through Cordis and disables the card', async (decision, outcome) => {
    const h = setup()
    const result = h.approval()
    h.bridge.handle('main', await h.action({ decision }))
    expect(await result).toBe(outcome)
    expect(h.sendCard).toHaveBeenCalledWith({ chatId: 'chat', threadId: 'topic' }, expect.anything(), { replyTo: 'execution', replyInThread: true })
    expect(JSON.stringify(h.updateCard.mock.calls[0])).not.toContain('button')
    h.bridge.handle('main', await h.action({ decision: 'allow' }))
    expect(h.updateCard).toHaveBeenCalledTimes(1)
    expect(h.waiting.mock.calls).toEqual([[true], [false]])
  })

  it('rejects another user, chat, card, channel, and unknown decisions without settling', async () => {
    const h = setup(); const result = h.approval(); const settled = vi.fn(); void result.then(settled)
    const a = await h.action()
    for (const change of [{ userId: 'other' }, { chatId: 'other' }, { messageId: 'other' }]) h.bridge.handle('main', { ...a, ...change })
    h.bridge.handle('other', a)
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled()
    h.bridge.handle('main', a); expect(await result).toBe('allowed-once')
  })

  it('uses the published approval service and preserves its audit and never policy', async () => {
    const h = setup()
    const service = new ApprovalService(h.ctx, { policy: 'ask' })
    const result = service.request({ agent: h.agent, toolName: 'bash', reason: 'Write requested config' })
    h.bridge.handle('main', await h.action())
    expect(await result).toBe('allowed-once')
    expect(h.agent.session.snapshotEvents().filter(e => e.type.startsWith('approval/')).map(e => e.type)).toEqual(['approval/asked', 'approval/decided'])
    h.agent.session.append('approval/policy', { policy: 'never' })
    expect(await service.request({ agent: h.agent, toolName: 'bash', reason: 'Blocked by policy' })).toBe('rejected')
    expect(h.sendCard).toHaveBeenCalledTimes(1)
  })

  it('returns answers through the published user question service', async () => {
    const h = setup()
    const get = h.ctx.get.bind(h.ctx)
    vi.spyOn(h.ctx, 'get').mockImplementation(name => name === 'agents' ? { get: () => h.agent, roots: () => [h.agent] } : get(name))
    const service = new UserQuestionService(h.ctx)
    const result = service.ask({ agent: h.agent, questions: [{ id: 'name', question: 'Name?' }] })
    const action = await h.action({ decision: 'submit' })
    h.bridge.handle('main', { ...action, formValue: { text_0: 'Answer' } })
    expect(await result).toEqual({ answers: [{ id: 'name', selected: [], custom: 'Answer' }] })
  })

  it('requires details for the exact tool call', async () => {
    const h = setup()
    expect(await h.approval({ callId: 'missing' as ApprovalRequest['callId'] })).toBe('unavailable')
    expect(h.sendCard).not.toHaveBeenCalled()
  })

  it('passes requests for a different agent to the next answerer', async () => {
    const h = setup()
    expect(await h.approval({ agent: {} as Agent })).toBe('unavailable')
    expect(h.sendCard).not.toHaveBeenCalled()
  })

  it('cancels on abort and ignores a late click', async () => {
    const h = setup(); const abort = new AbortController(); const result = h.approval({ signal: abort.signal })
    const a = await h.action(); abort.abort()
    expect(await result).toBe('cancelled')
    h.bridge.handle('main', a); expect(h.updateCard).toHaveBeenCalledTimes(1)
  })

  it('cancels on timeout and gateway shutdown', async () => {
    vi.useFakeTimers()
    const h = setup(); const result = h.approval()
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toBe('cancelled')
    const second = h.approval(); h.bridge.close(); expect(await second).toBe('cancelled')
  })

  it('fails closed on card send failure', async () => {
    const h = setup(); h.sendCard.mockRejectedValue(new Error('offline'))
    expect(await h.approval()).toBe('unavailable')
    expect(h.waiting.mock.calls).toEqual([[true], [false]])
  })

  it('marks a card expired if the request was cancelled during sending', async () => {
    const h = setup(); let sent!: (value: { messageId: string }) => void
    h.sendCard.mockImplementation(() => new Promise(resolve => { sent = resolve }))
    const abort = new AbortController(); const result = h.approval({ signal: abort.signal })
    await vi.waitFor(() => expect(sent).toBeDefined()); abort.abort(); expect(await result).toBe('cancelled')
    sent({ messageId: 'late-card' }); await vi.waitFor(() => expect(h.updateCard).toHaveBeenCalledWith('late-card', expect.anything()))
  })

  it('returns selected and typed answers, and leaves invalid submissions pending', async () => {
    const h = setup(); const result = h.questions(); const a = await h.action({ decision: 'submit' })
    h.bridge.handle('main', { ...a, formValue: { choice_0: '8' } })
    expect(JSON.stringify(h.updateCard.mock.calls[0])).toContain('回答未提交')
    const requestId = JSON.stringify(h.updateCard.mock.calls[0]![1]).match(/"requestId":"([^"]+)"/)![1]
    h.bridge.handle('main', { ...a, value: { requestId, decision: 'submit' }, formValue: { choice_0: '1', text_0: 'Details' } })
    expect(await result).toEqual({ answers: [{ id: 'q1', selected: ['B'], custom: 'Details' }] })
  })

  it('cancels questions when the turn is disposed', async () => {
    const h = setup(); const result = h.questions(); const failed = expect(result).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await h.action(); h.dispose(); await failed
  })

  it('renders and validates multi-question, multi-select, free-text and plan review inputs', () => {
    const questions = [
      { id: 'multi', question: 'Choose', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'text', question: 'Name?' },
      { id: 'plan', question: 'Proceed?', detail: 'The complete plan', intent: { kind: 'plan-review' as const, approve: 'Yes' }, options: [{ label: 'Yes' }, { label: 'No' }] },
    ]
    const rendered = JSON.stringify(questionCard('id', questions))
    expect(rendered).toContain('"form_action_type":"submit"')
    expect(rendered).not.toContain('"input_type":"multiline"')
    expect(rendered).toContain('The complete plan'); expect(rendered).toContain('multi_select_static')
    const a = { messageId: 'card', chatId: 'chat', userId: 'u', value: { decision: 'submit' }, formValue: { choice_0: ['0', '1'], text_1: 'Name', choice_2: '1' } }
    expect(parseAnswers(questions, a)).toEqual({ answers: [{ id: 'multi', selected: ['A', 'B'] }, { id: 'text', selected: [], custom: 'Name' }, { id: 'plan', selected: ['No'] }] })
    expect(parseAnswers(questions, { ...a, formValue: { ...a.formValue, choice_2: ['0', '1'] } })).toBeUndefined()
  })
})
