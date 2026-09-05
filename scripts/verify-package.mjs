import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const pluginManifest = JSON.parse(await readFile(resolve(root, 'dsh.plugin.json'), 'utf8'))

assert.equal(packageJson.name, 'dsh-lark-claw')
assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(packageJson.publishConfig?.access, 'public')
assert.equal(packageJson.publishConfig?.registry, 'https://registry.npmjs.org')
assert.equal(packageJson.repository?.url, 'git+https://github.com/Illuminated2020/dsh-lark-claw.git')
assert.equal(pluginManifest.id, 'dsh-external/dsh-lark-claw')
assert.equal(pluginManifest.version, packageJson.version, 'dsh.plugin.json version must match package.json')
assert.equal(pluginManifest.engines?.dsh, '>=0.1.2-rc.1')

const publishedFiles = new Set(packageJson.files)
for (const entry of ['lib', 'cordis.patch.yml', 'dsh.plugin.json', 'config.yaml.example', 'README.md', 'README.zh.md', 'guides', 'LICENSE']) {
  assert.ok(publishedFiles.has(entry), `package.json files must include ${entry}`)
}

const exportTargets = Object.values(packageJson.exports).flatMap((entry) =>
  typeof entry === 'string' ? [entry] : Object.values(entry),
)
for (const target of exportTargets) await access(resolve(root, target))

const patch = await readFile(resolve(root, packageJson.dsh.bundle.patch), 'utf8')
for (const moduleName of ['dsh-lark-claw/config', 'dsh-lark-claw/gateway', 'dsh-lark-claw/cron']) {
  assert.ok(patch.includes(`name: '${moduleName}'`), `bundle patch must mount ${moduleName}`)
}

console.log(`verified ${packageJson.name}@${packageJson.version} bundle metadata and build outputs`)
