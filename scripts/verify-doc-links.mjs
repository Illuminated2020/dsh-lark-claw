import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const documents = [
  'README.md',
  'README.zh.md',
  'guides/advanced.md',
  'guides/advanced.zh.md',
  'guides/releasing.md',
  'guides/releasing.zh.md',
]

for (const document of documents) {
  const source = await readFile(resolve(root, document), 'utf8')
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)
  for (const match of links) {
    const target = match[1]
    assert.ok(target !== undefined)
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue
    const path = decodeURIComponent(target.split('#', 1)[0])
    if (path === '') continue
    try {
      await access(resolve(root, dirname(document), path))
    } catch {
      assert.fail(`${document} links to missing local path ${target}`)
    }
  }
}

console.log(`verified local links in ${String(documents.length)} documentation files`)
