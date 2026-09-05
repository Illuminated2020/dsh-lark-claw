/** Resolve dsh human requests through cards owned by the initiating Feishu user. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError, type AskUserQuestionItem, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { FeishuCardAction, FeishuTarget, FeishuTransport } from './types.ts'

type Card = Readonly<Record<string, unknown>>
interface Owner {
  agent: Agent
  transport: FeishuTransport
  target: FeishuTarget
  anchor: string
  userId: string
  waiting: (active: boolean) => void
}
interface Pending {
  owner: Owner
  messageId?: string
  accept: (action: FeishuCardAction) => void
  cancel: () => void
}
const plain = (content: string) => ({ tag: 'plain_text', content })
const markdown = (content: string) => ({ tag: 'markdown', content })
const button = (label: string, value: object, submit = false) => ({
  tag: 'button', text: plain(label), type: 'default',
  behaviors: [{ type: 'callback', value }],
  ...(submit ? { name: 'submit', action_type: 'form_submit', form_action_type: 'submit' } : {}),
})
function card(title: string, elements: object[]): Card {
  return { schema: '2.0', config: { update_multi: true }, header: { title: plain(title), template: 'orange' }, body: { elements } }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function code(text: string): string {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)))
  return `${fence}\n${text}\n${fence}`
}
function approvalDetails(req: ApprovalRequest): string | undefined {
  if (req.callId === undefined) return req.reason
  for (const event of req.agent.session.snapshotEvents()) {
    if (event.type === 'tool/call' && event.data.callId === req.callId) return event.data.arguments
    if (event.type === 'assistant/message') {
      const block = event.data.message.content.find(b => b.type === 'tool-call' && b.id === req.callId)
      if (block?.type === 'tool-call') return block.arguments
    }
  }
  return undefined
}

/** One gateway's pending questions; never persisted or replayed after restart. */
export class FeishuInteractions {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly ctx: Context, private readonly timeoutMs: number) {}

  /** Install answerers only for this live turn and its initiating user. */
  bind(owner: Owner): () => void {
    const disposeApproval = this.ctx.on('approval/request', (req, next) => {
      if (req.agent !== owner.agent) return next()
      const detail = approvalDetails(req)
      // Never ask the user to authorize a tool call whose arguments cannot be shown.
      if (detail === undefined) return Promise.resolve('unavailable' as const)
      return this.ask(owner, req.signal, id => card('需要你的批准', [
        markdown(`工具：${req.toolName}\n\n${req.reason ?? '此操作需要授权'}\n\n操作详情：\n${code(detail)}`),
        button('允许本次', { requestId: id, decision: 'allow' }),
        button('拒绝', { requestId: id, decision: 'reject' }),
      ]), action => {
        if (!record(action.value)) return undefined
        if (action.value.decision === 'allow') return 'allowed-once' as const
        if (action.value.decision === 'reject') return 'rejected' as const
        return undefined
      }).then(answer => answer ?? 'cancelled', () => 'unavailable')
    })
    const disposeQuestions = this.ctx.on('user-questions/request', async (req, next) => {
      if (req.agent !== owner.agent) return next()
      const result = await this.ask(owner, req.signal, id => questionCard(id, req.questions), action => parseAnswers(req.questions, action))
      if (result === undefined) throw new UserQuestionError('Feishu question cancelled or expired', 'ASK_ABORTED')
      return result
    })
    return () => {
      disposeApproval()
      disposeQuestions()
      for (const pending of this.pending.values()) if (pending.owner === owner) pending.cancel()
    }
  }

  /** Dispatch outside the turn queue; identity and exact card ownership are required. */
  handle(channelId: string, action: FeishuCardAction): void {
    if (!record(action.value) || typeof action.value.requestId !== 'string') return
    const pending = this.pending.get(action.value.requestId)
    if (pending === undefined || pending.owner.transport.channelId !== channelId
      || pending.messageId !== action.messageId || pending.owner.target.chatId !== action.chatId
      || pending.owner.userId !== action.userId) return
    if (action.value.decision === 'cancel') pending.cancel()
    else pending.accept(action)
  }

  /** Cancel before gateway shutdown drains turns waiting for a human. */
  close(): void {
    for (const pending of this.pending.values()) pending.cancel()
  }

  private ask<T>(owner: Owner, signal: AbortSignal | undefined, render: (id: string) => Card,
    decode: (action: FeishuCardAction) => T | undefined): Promise<T | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined)
    let id = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      let receipt: string | undefined
      let finalLabel = '已取消或已过期'
      const update = () => {
        if (receipt === undefined) return
        void owner.transport.updateCard(receipt, card(finalLabel, [markdown(finalLabel)]))
          .catch(() => { this.ctx.logger.warn('feishu-gateway could not update settled interaction card') })
      }
      const finish = (result: T | undefined, error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.pending.delete(id)
        owner.waiting(false)
        finalLabel = result === 'allowed-once' ? '已批准，仅限本次' : result === 'rejected' ? '已拒绝' : result === undefined ? '已取消或已过期' : '已提交回答'
        update()
        if (error !== undefined) reject(error)
        else resolve(result)
      }
      const cancel = () => finish(undefined)
      const timer = setTimeout(cancel, this.timeoutMs)
      timer.unref()
      const pending: Pending = { owner, cancel, accept: action => {
        const answer = decode(action)
        if (answer !== undefined) finish(answer)
        else if (receipt !== undefined) {
          // The SDK deduplicates by button value, excluding form fields. A new token permits correction.
          this.pending.delete(id)
          id = randomUUID()
          this.pending.set(id, pending)
          const next = render(id)
          void owner.transport.updateCard(receipt, { ...next, header: { title: plain('回答未提交，请补全或检查选项后重试'), template: 'orange' } })
            .catch(error => finish(undefined, error))
        }
      } }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', cancel, { once: true })
      owner.waiting(true)
      // Include rendering in the promise so malformed or oversized cards cannot strand a request.
      void Promise.resolve().then(() => owner.transport.sendCard(owner.target, render(id), { replyTo: owner.anchor, replyInThread: true }))
        .then(sent => {
          receipt = sent.messageId
          pending.messageId = receipt
          if (settled) update()
        }, error => finish(undefined, error))
    })
  }
}

/** Render all questions in one submitted form, with no preselected decisions. */
export function questionCard(id: string, questions: readonly AskUserQuestionItem[]): Card {
  const elements: object[] = []
  questions.forEach((q, i) => {
    elements.push(markdown(`${q.question}${q.detail === undefined ? '' : `\n\n${q.detail}`}`))
    if (q.options?.length) {
      elements.push({ tag: q.multiSelect ? 'multi_select_static' : 'select_static', name: `choice_${i}`,
        placeholder: plain('选择答案'), options: q.options.map((o, n) => ({ text: plain(o.label), value: String(n) })) })
      for (const option of q.options) if (option.description) elements.push(markdown(`${option.label}：${option.description}`))
    }
    elements.push({ tag: 'input', name: `text_${i}`, placeholder: plain('填写或补充回答') })
  })
  elements.push(button('提交回答', { requestId: id, decision: 'submit' }, true))
  return card(questions.some(q => q.intent?.kind === 'plan-review') ? '请确认方案' : '需要你的回答', [
    { tag: 'form', name: 'answers', elements },
    button('取消', { requestId: id, decision: 'cancel' }),
  ])
}

/** Validate external form fields against the exact original questions and options. */
export function parseAnswers(questions: readonly AskUserQuestionItem[], action: FeishuCardAction): AskUserQuestionAnswer | undefined {
  if (!record(action.value) || action.value.decision !== 'submit' || !record(action.formValue)) return undefined
  const answers: AskUserQuestionAnswer['answers'] = []
  for (const [i, q] of questions.entries()) {
    const raw = action.formValue[`choice_${i}`]
    const rawText = action.formValue[`text_${i}`]
    if (rawText !== undefined && typeof rawText !== 'string') return undefined
    const custom = typeof rawText === 'string' ? rawText.trim() : ''
    const values = raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw]
    if (!q.multiSelect && values.length > 1) return undefined
    const selected: string[] = []
    for (const value of values) {
      if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined
      const option = q.options?.[Number(value)]
      if (option === undefined || selected.includes(option.label)) return undefined
      selected.push(option.label)
    }
    if (selected.length === 0 && custom === '') return undefined
    answers.push({ id: q.id, selected, ...(custom === '' ? {} : { custom }) })
  }
  return { answers }
}
