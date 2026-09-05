import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Domain, type LarkChannel } from '@larksuiteoapi/node-sdk'

const { createLarkChannel } = vi.hoisted(() => ({ createLarkChannel: vi.fn() }))

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>('@larksuiteoapi/node-sdk')
  return { ...actual, createLarkChannel }
})

import { LarkFeishuTransport, LarkFeishuTransportFactory } from '../../src/gateway/transport.ts'

describe('LarkFeishuTransport message lifecycle', () => {
  it.each(['image', 'file'] as const)('downloads inbound %s through its source message', async (type) => {
    const get = vi.fn(async () => ({ getReadableStream: () => Readable.from([Buffer.from([1, 2]), Buffer.from([3])]) }))
    const downloadResource = vi.fn().mockRejectedValue(new Error('Request failed with status code 400'))
    const transport = new LarkFeishuTransport('main', {
      rawClient: { im: { v1: { messageResource: { get } } } }, downloadResource,
    } as unknown as LarkChannel)
    expect(await transport.downloadResource('source-message', 'resource-key', type)).toEqual(Buffer.from([1, 2, 3]))
    expect(get).toHaveBeenCalledWith({ path: { message_id: 'source-message', file_key: 'resource-key' }, params: { type } })
    expect(downloadResource).not.toHaveBeenCalled()
  })

  it.each([
    ['file', { file_key: 'key', file_name: 'report.pdf' }, 'file'],
    ['audio', { file_key: 'key' }, 'audio'],
    ['media', { file_key: 'key', file_name: 'clip.mp4' }, 'video'],
    ['image', { image_key: 'key' }, 'image'],
    ['post', { title: '', content: [[{ tag: 'img', image_key: 'key' }]] }, 'image'],
  ])('reads %s resources from the explicitly replied message', async (msg_type, body, type) => {
    const get = vi.fn(async () => ({ code: 0, data: { items: [{ message_id: 'parent', chat_id: 'chat', msg_type, body: { content: JSON.stringify(body) } }] } }))
    const transport = new LarkFeishuTransport('main', { rawClient: { im: { v1: { message: { get } } } } } as unknown as LarkChannel)
    expect(await transport.getMessageResources('parent', 'chat')).toEqual([expect.objectContaining({ type, fileKey: 'key' })])
    expect(get).toHaveBeenCalledWith({ path: { message_id: 'parent' } })
  })

  it.each([
    { message_id: 'parent', chat_id: 'other-chat' },
    { message_id: 'other-message', chat_id: 'chat' },
    { message_id: 'parent', chat_id: 'chat', deleted: true },
  ])('rejects unavailable or mismatched reply targets', async (item) => {
    const get = vi.fn(async () => ({ data: { items: [item] } }))
    const transport = new LarkFeishuTransport('main', { rawClient: { im: { v1: { message: { get } } } } } as unknown as LarkChannel)
    await expect(transport.getMessageResources('parent', 'chat')).rejects.toThrow()
  })

  it('resolves a configured topic to a message before sending a scheduled card or media', async () => {
    const list = vi.fn(async () => ({ data: { items: [{ message_id: 'root-42', chat_id: 'chat-1' }] } }))
    const reply = vi.fn(async () => ({ data: { message_id: 'card', thread_id: 'thread-42' } }))
    const create = vi.fn()
    const send = vi.fn(async () => ({ messageId: 'file' }))
    const transport = new LarkFeishuTransport('main', { rawClient: { im: { message: { list, reply, create } } }, send } as unknown as LarkChannel)
    const target = { chatId: 'chat-1', threadId: 'thread-42' }
    await transport.sendCard(target, { schema: '2.0' })
    await transport.sendText(target, 'scheduled text')
    await transport.sendFile(target, new Uint8Array([1]), 'report.txt')
    await transport.sendImage(target, new Uint8Array([2]), 'image.png')
    expect(list).toHaveBeenCalledWith({ params: { container_id_type: 'thread', container_id: 'thread-42', sort_type: 'ByCreateTimeAsc', page_size: 20 } })
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'root-42' }, data: expect.objectContaining({ reply_in_thread: true }) }))
    expect(send).toHaveBeenCalledWith('chat-1', expect.anything(), { replyTo: 'root-42', replyInThread: true })
    expect(create).not.toHaveBeenCalled()
  })

  it('fails instead of silently posting to the chat when a topic cannot be resolved', async () => {
    const create = vi.fn()
    const list = vi.fn(async () => ({ data: { items: [] } }))
    const transport = new LarkFeishuTransport('main', { rawClient: { im: { message: { list, create } } } } as unknown as LarkChannel)
    await expect(transport.sendText({ chatId: 'chat-1', threadId: 'missing' }, 'hello')).rejects.toThrow('Cannot resolve')
    expect(create).not.toHaveBeenCalled()
  })

  it('establishes a new topic after posting an independent card', async () => {
    const create = vi.fn(async () => ({ data: { message_id: 'root-card' } }))
    const reply = vi.fn(async () => ({ data: { message_id: 'continuation', thread_id: 'new-thread' } }))
    const transport = new LarkFeishuTransport('main', { rawClient: { im: { message: { reply, create } } } } as unknown as LarkChannel)
    expect(await transport.sendCard({ chatId: 'chat-1' }, {})).toEqual({ messageId: 'root-card', threadId: 'new-thread' })
    expect(reply).toHaveBeenCalledWith({ path: { message_id: 'root-card' }, data: {
      msg_type: 'text', content: JSON.stringify({ text: 'Reply here to continue the conversation.「你可以直接在这里继续对话。」💬' }), reply_in_thread: true,
    } })
  })

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
