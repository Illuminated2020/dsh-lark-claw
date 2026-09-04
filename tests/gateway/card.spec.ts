import { describe, expect, it } from 'vitest'
import { boundExecutionCard, toFeishuCard } from '../../src/gateway/card.ts'

interface TestCard {
  readonly body: {
    readonly elements: Array<{
      readonly tag: string
      readonly expanded?: boolean
      readonly header?: { readonly title: { readonly content: string } }
      readonly icon?: { readonly token: string }
      readonly content?: string
    }>
  }
  readonly config: { readonly summary: { readonly content: string } }
}

function testCard(value: Readonly<Record<string, unknown>>): TestCard {
  return value as unknown as TestCard
}

describe('Execution Card projection', () => {
  it('bounds markdown and folds old tool steps while preserving a valid card shape', () => {
    const projection = {
      title: 'DeepSeek Harness',
      status: 'running' as const,
      markdown: 'x'.repeat(500),
      thinking: '检查工作区'.repeat(100),
      steps: Array.from({ length: 30 }, (_, index) => ({ label: `tool-${String(index)}`, status: 'completed' as const })),
    }
    const bounded = boundExecutionCard(projection, 120)
    expect(bounded.markdown.length).toBeLessThanOrEqual(120)
    expect(bounded.thinking?.length).toBeLessThanOrEqual(120)
    expect(bounded.steps).toHaveLength(30)
    expect(bounded.steps[0]?.label).toBe('tool-0')
    const card = toFeishuCard(projection, 120)
    expect(card.schema).toBe('2.0')
    expect(card).not.toHaveProperty('header')
    const elements = (card.body as { elements: readonly { tag: string }[] }).elements
    expect(elements[0]?.tag).toBe('collapsible_panel')
    expect((card.config as { streaming_mode: boolean; update_multi: boolean }).streaming_mode).toBe(true)
    expect((card.config as { streaming_mode: boolean; update_multi: boolean }).update_multi).toBe(true)
  })

  it('matches streaming and final card phases', () => {
    const streaming = toFeishuCard({
      title: 'ignored by card renderer',
      status: 'running',
      markdown: 'not shown while streaming',
      steps: [{ label: 'Run sub-agent', icon: 'robot_outlined', status: 'running' }],
    })
    const streamingCard = testCard(streaming)
    expect(streamingCard.body.elements).toHaveLength(2)
    expect(streamingCard.body.elements[0]?.tag).toBe('collapsible_panel')
    expect(streamingCard.body.elements[0]?.expanded).toBe(true)
    expect(streamingCard.body.elements[0]?.header?.title.content).toBe('Working on it (1 step)')
    expect(streamingCard.body.elements[1]).toMatchObject({ tag: 'div', icon: { token: 'more_outlined' } })
    expect(JSON.stringify(streamingCard)).not.toContain('not shown while streaming')

    const final = toFeishuCard({
      title: 'ignored by card renderer',
      status: 'completed',
      markdown: '最终答案',
      steps: [{ label: 'Run sub-agent', icon: 'robot_outlined', status: 'completed' }],
    })
    const finalCard = testCard(final)
    expect(finalCard.body.elements).toHaveLength(2)
    expect(finalCard.body.elements[0]?.expanded).toBe(false)
    expect(finalCard.body.elements[0]?.header?.title.content).toBe('Show 1 step')
    expect(finalCard.body.elements[1]).toEqual({ tag: 'markdown', content: '最终答案' })
    expect(finalCard.config.summary.content).toBe('最终答案')
  })
})
