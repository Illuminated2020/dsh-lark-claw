import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-lark-claw-pack-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  const packed = spawnSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory], {
    cwd: root,
    encoding: 'utf8',
  })
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || 'npm pack failed')

  const result = JSON.parse(packed.stdout)[0]
  assert.equal(result.name, 'dsh-lark-claw')
  const paths = new Set(result.files.map(file => file.path))
  const required = [
    'LICENSE',
    'README.md',
    'README.zh.md',
    'config.yaml.example',
    'cordis.patch.yml',
    'dsh.plugin.json',
    'guides/advanced.md',
    'guides/advanced.zh.md',
    'guides/releasing.md',
    'guides/releasing.zh.md',
    'lib/index.js',
    'lib/gateway/index.js',
    'lib/cron/index.js',
    'lib/config/index.js',
    'package.json',
    'scripts/dsh-lark-claw-service.sh',
  ]
  for (const path of required) assert.ok(paths.has(path), `packed tarball is missing ${path}`)
  assert.equal(result.files.find(file => file.path === 'scripts/dsh-lark-claw-service.sh')?.mode, 0o755)

  console.log(`verified packed tarball ${result.filename} (${String(result.size)} bytes)`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
