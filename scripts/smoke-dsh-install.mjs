import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-lark-claw-smoke-'))
const dshVersion = process.env.DSH_VERSION ?? '0.1.2-rc.1'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const environment = { ...process.env, DSH_HOME: join(temporaryDirectory, 'dsh-home') }

function run(command, args, { capture = false } = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    timeout: 300_000,
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.stderr ?? result.stdout ?? `exit code ${String(result.status)}`
    throw new Error(`command failed: ${command} ${args.join(' ')}\n${reason}`)
  }
  return result.stdout ?? ''
}

function runExpectedFailure(command, args, expected) {
  console.log(`> ${command} ${args.join(' ')} (expecting configuration rejection after module load)`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    timeout: 300_000,
    stdio: 'pipe',
  })
  assert.notEqual(result.status, 0, 'unconfigured profile unexpectedly started')
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.ok(output.includes(expected), `runtime did not reach expected configuration check: ${expected}`)
}

try {
  const packResult = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory], { capture: true }))[0]
  assert.equal(packResult.name, 'dsh-lark-claw')
  const tarball = join(temporaryDirectory, packResult.filename)

  run(pnpm, ['dlx', `@deepseek-ai/dsh@${dshVersion}`, 'plugin', '--profile', 'feishu', 'add', tarball, '--prefer-offline'])
  const composed = run(pnpm, ['dlx', `@deepseek-ai/dsh@${dshVersion}`, '--profile', 'feishu', '--dump-config'], { capture: true })

  for (const expected of ['# == dsh-lark-claw', 'name: dsh-lark-claw/gateway', 'name: dsh-lark-claw/cron']) {
    assert.ok(composed.includes(expected), `composed dsh profile is missing ${expected}`)
  }

  const profileManifest = JSON.parse(await readFile(join(environment.DSH_HOME, 'profiles', 'feishu', 'package.json'), 'utf8'))
  assert.ok(profileManifest.dsh?.profile?.bundles?.includes('dsh-lark-claw'))
  runExpectedFailure(
    pnpm,
    ['dlx', `@deepseek-ai/dsh@${dshVersion}`, '--profile', 'feishu', '--help'],
    'feishu-gateway requires at least one channel',
  )
  console.log(`verified dsh ${dshVersion} installs, composes, and loads ${packResult.filename}`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
