import { describe, expect, it, vi } from 'vitest'
import { Domain, type LarkChannel } from '@larksuiteoapi/node-sdk'

const { createLarkChannel } = vi.hoisted(() => ({ createLarkChannel: vi.fn() }))

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>('@larksuiteoapi/node-sdk')
  return { ...actual, createLarkChannel }
})

import { LarkFeishuTransport, LarkFeishuTransportFactory } from '../../src/gateway/transport.ts'

describe('LarkFeishuTransport message lifecycle', () => {
  it('uses message.reply and preserves Feishu thread_id for durable session binding', async () => {
    const reply = vi.fn(async () => ({ data: { message_id: 'assistant-card', thread_id: 'thread-42' } }))
    const channel = {
      rawClient: { im: { message: { reply, create: vi.fn() } } },
    } as unknown as LarkChannel
    const transport = new LarkFeishuTransport('main', channel)

    const receipt = await transport.sendCard(
      { chatId: 'chat-1' },
      { schema: '2.0' },
      { replyTo: 'inbound-message', replyInThread: true },
    )

    expect(receipt).toEqual({ messageId: 'assistant-card', threadId: 'thread-42' })
    expect(reply).toHaveBeenCalledWith({
      path: { message_id: 'inbound-message' },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0' }),
        reply_in_thread: true,
      },
    })
  })

  it('passes the Lark API domain to the official SDK', () => {
    createLarkChannel.mockReturnValue({} as LarkChannel)
    const factory = new LarkFeishuTransportFactory()

    factory.create({
      channelId: 'lark-main',
      appId: 'cli_test',
      appSecret: 'secret',
      domain: 'lark',
    })

    expect(createLarkChannel).toHaveBeenCalledWith(expect.objectContaining({ domain: Domain.Lark }))
  })

})
