import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config } from '../../src/gateway/index.ts'
import { loadDshLarkClawConfig } from '../../src/config/index.ts'

describe('Feishu Gateway configuration schema', () => {
  it('accepts a channel without a proactive target', () => {
    const config = Config({
      workspace: '/tmp/dsh-lark-claw-test',
      channels: [{
        id: 'main',
        appId: 'cli_test',
        appSecret: 'secret',
      }],
    })

    expect(config.channels[0]?.proactiveTarget).toBeUndefined()
  })

  it('preserves the Lark domain from YAML without requiring a chat target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-claw-config-'))
    const path = join(directory, 'config.yaml')
    try {
      await writeFile(path, [
        'messaging:',
        '  channels:',
        '    - id: lark-main',
        '      type: lark',
        '      params:',
        '        app_id: cli_test',
        '        app_secret: secret',
      ].join('\n'))

      const config = await loadDshLarkClawConfig(path)
      expect(config.gateway.channels[0]?.domain).toBe('lark')
      expect(config.gateway.channels[0]?.proactiveTarget).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
