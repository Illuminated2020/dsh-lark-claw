import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const pluginManifestPath = resolve(root, 'dsh.plugin.json')
const pluginManifest = JSON.parse(await readFile(pluginManifestPath, 'utf8'))

pluginManifest.version = packageJson.version
await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`)
console.log(`synchronized dsh.plugin.json to ${packageJson.version}`)
