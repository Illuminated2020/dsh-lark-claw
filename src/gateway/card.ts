/** Execution Card projection; Feishu SDK calls stay at the transport seam. */

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExecutionCardProjection, ExecutionCardStep } from './types.ts'

const CARD_MARKDOWN_LIMIT = 28_000
const MAX_FEISHU_CARD_ELEMENTS = 200

/**
 * Keep a card bounded while preserving its final answer and newest steps.
 * @param projection - provider-neutral card state to bound.
 * @param markdownLimit - requested markdown limit, capped at the Feishu card limit.
 * @returns a bounded copy of the projection.
 */
export function boundExecutionCard(projection: ExecutionCardProjection, markdownLimit = CARD_MARKDOWN_LIMIT): ExecutionCardProjection {
  const limit = Math.max(1, Math.min(markdownLimit, CARD_MARKDOWN_LIMIT))
  const notice = '\n\n_输出过长，旧内容已裁剪；完整结果保留在 dsh Session 中。_'
  const markdown = projection.markdown.length <= limit
    ? projection.markdown
    : limit <= notice.length ? notice.slice(0, limit) : `${projection.markdown.slice(0, limit - notice.length)}${notice}`
  const thinking = projection.thinking === undefined || projection.thinking.length <= limit
    ? projection.thinking
    : limit <= notice.length ? notice.slice(0, limit) : `${projection.thinking.slice(0, limit - notice.length)}${notice}`
  return { ...projection, markdown, ...thinking === undefined ? {} : { thinking } }
}

function countElements(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  const item = value as Record<string, unknown>
  const self = typeof item.tag === 'string' ? 1 : 0
  return Object.values(item).reduce<number>((count, child) => (
    count + (Array.isArray(child)
      ? child.reduce<number>((sum, entry) => sum + countElements(entry), 0)
      : countElements(child))
  ), self)
}

function stepElement(step: ExecutionCardStep): CardElement {
  return {
    tag: 'div',
    icon: {
      tag: 'standard_icon',
      token: step.icon ?? 'setting-inter_outlined',
      color: 'grey',
    },
    text: {
      tag: 'plain_text',
      text_color: 'grey',
      text_size: 'notation',
      content: step.label,
    },
  }
}

interface CardElement extends Record<string, unknown> {
  readonly tag: string
}

interface CardStepPanel extends CardElement {
  readonly tag: 'collapsible_panel'
  elements: CardElement[]
  header: { title: { content: string } }
}

interface FeishuCard extends Record<string, unknown> {
  config: { summary: { content: string }; [key: string]: unknown }
  body: { elements: CardElement[] }
}

/** Trim old step rows to stay within Feishu card limits. */
function trimCardElements(card: FeishuCard): void {
  const stepPanel = card.body.elements.find((element): element is CardStepPanel => {
    if (element.tag !== 'collapsible_panel') return false
    const candidate = element as { elements?: unknown; header?: unknown }
    return Array.isArray(candidate.elements) && candidate.header !== undefined
  })
  if (stepPanel === undefined) return
  while (stepPanel.elements.length > 0 && countElements(card) > MAX_FEISHU_CARD_ELEMENTS) {
    stepPanel.elements.shift()
  }
}

/** Split markdown into Feishu-compatible chunks of at most five tables. */
const MARKDOWN_TABLE_REGEX = /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gmu

export function splitMarkdownByTables(markdown: string, maxTables = 5): string[] {
  const tables = markdown.match(MARKDOWN_TABLE_REGEX)
  if (tables === null || tables.length <= maxTables) return [markdown]
  const positions: Array<{ start: number; end: number }> = []
  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, 'gmu')
  let match: RegExpExecArray | null
  while ((match = regex.exec(markdown)) !== null) {
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  const chunks: string[] = []
  let start = 0
  let count = 0
  for (const position of positions) {
    count += 1
    if (count >= maxTables && position !== positions.at(-1)) {
      chunks.push(markdown.slice(start, position.end).trim())
      start = position.end
      count = 0
    }
  }
  const remaining = markdown.slice(start).trim()
  if (remaining !== '') chunks.push(remaining)
  return chunks.length === 0 ? [markdown] : chunks
}

export interface FeishuCardResourceOptions {
  readonly workspace?: string
  readonly uploadImage?: (data: Uint8Array, fileName: string) => Promise<string>
}

function localWorkspacePath(workspace: string | undefined, reference: string): string | undefined {
  if (workspace === undefined || reference.includes('://')) return undefined
  const root = resolve(workspace)
  const candidate = resolve(workspace, reference)
  const relativePath = relative(root, candidate)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined
  return candidate
}

/** Resolve Markdown image references before final render. */
async function uploadMarkdownImages(markdown: string, options: FeishuCardResourceOptions): Promise<string> {
  if (options.uploadImage === undefined) return markdown
  const images = markdown.match(/!\[.*?\]\((.*?)\)/g)
  if (images === null) return markdown
  for (const image of images) {
    const match = /!\[.*?\]\((.*?)\)/u.exec(image)
    const reference = match?.[1]
    if (reference === undefined || reference === '') continue
    try {
      let data: Uint8Array
      let fileName: string
      if (reference.startsWith('http:') || reference.startsWith('https:')) {
        const response = await fetch(reference)
        if (!response.ok) throw new Error(`image download failed with ${String(response.status)}`)
        data = new Uint8Array(await response.arrayBuffer())
        fileName = basename(new URL(reference).pathname) || 'image'
      } else {
        const path = localWorkspacePath(options.workspace, reference)
        if (path === undefined) {
          markdown = markdown.replaceAll(image, '')
          continue
        }
        data = await readFile(path)
        fileName = basename(path)
      }
      const imageKey = await options.uploadImage(data, fileName)
      markdown = markdown.replaceAll(image, `![image](${imageKey})`)
    } catch {
      markdown = markdown.replaceAll(image, reference.startsWith('http:') || reference.startsWith('https:')
        ? `[${reference}](${reference})`
        : '')
    }
  }
  return markdown
}

/** Render a final card after Markdown resource handling. */
export async function renderFeishuCard(
  projection: ExecutionCardProjection,
  markdownLimit?: number,
  options: FeishuCardResourceOptions = {},
): Promise<Readonly<Record<string, unknown>>> {
  const markdown = projection.status === 'running'
    ? projection.markdown
    : await uploadMarkdownImages(boundExecutionCard(projection, markdownLimit).markdown, options)
  return toFeishuCard({ ...projection, markdown }, markdownLimit)
}

/**
 * Build a valid Feishu interactive card v2 from a provider-neutral projection.
 * @param projection - provider-neutral card state to render.
 * @param markdownLimit - optional markdown limit applied before rendering.
 * @returns an SDK-neutral Feishu card object.
 */
export function toFeishuCard(projection: ExecutionCardProjection, markdownLimit?: number): Readonly<Record<string, unknown>> {
  const bounded = boundExecutionCard(projection, markdownLimit)
  const steps = [
    ...bounded.thinking === undefined || bounded.thinking === '' ? [] : [{
      label: bounded.thinking,
      status: 'completed' as const,
      icon: 'robot_outlined',
    }],
    ...bounded.steps,
  ]
  const card: FeishuCard = {
    schema: '2.0',
    config: {
      streaming_mode: true,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: 'fill',
      summary: { content: '' },
    },
    body: {
      elements: [{
        tag: 'collapsible_panel',
        expanded: bounded.status === 'running',
        border: { color: 'grey-300', corner_radius: '6px' },
        vertical_spacing: '2px',
        header: {
          title: {
            tag: 'plain_text',
            text_color: 'grey',
            text_size: 'notation',
            content: '',
          },
          icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
          icon_position: 'right',
          icon_expanded_angle: 90,
        },
        elements: steps.map(stepElement),
      }],
    },
  }
  if (bounded.status !== 'running' && bounded.markdown !== '') {
    card.config.summary.content = bounded.markdown
    card.body.elements.push({ tag: 'markdown', content: bounded.markdown })
  }
  const stepPanel = card.body.elements[0]
  if (stepPanel?.tag === 'collapsible_panel') {
    const panel = stepPanel as CardStepPanel
    const totalStepCount = panel.elements.length
    if (totalStepCount > 0) {
      const stepCountText = `${String(totalStepCount)} ${totalStepCount === 1 ? 'step' : 'steps'}`
      panel.header.title.content = bounded.status === 'running'
        ? `Working on it (${stepCountText})`
        : `Show ${stepCountText}`
      if (bounded.status === 'running') card.config.summary.content = `Working on it (${stepCountText})`
    } else {
      card.body.elements.splice(0, 1)
    }
  }
  if (card.body.elements.length === 0) {
    card.body.elements.push({ tag: 'div', text: { tag: 'plain_text', content: '' } })
  }
  if (bounded.status === 'running') {
    card.body.elements.push({
      tag: 'div',
      icon: { tag: 'standard_icon', token: 'more_outlined', color: 'grey' },
    })
  }
  trimCardElements(card)
  return card
}
