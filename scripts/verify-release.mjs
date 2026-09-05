import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const releaseTag = process.env.RELEASE_TAG
const releasePrerelease = process.env.RELEASE_PRERELEASE

assert.ok(releaseTag, 'RELEASE_TAG is required')
assert.ok(releasePrerelease === 'true' || releasePrerelease === 'false', 'RELEASE_PRERELEASE must be true or false')
assert.equal(releaseTag, `v${packageJson.version}`, 'GitHub Release tag must match package.json version')
assert.equal(releasePrerelease === 'true', packageJson.version.includes('-'), 'GitHub prerelease flag must match the package version')

console.log(`verified release ${releaseTag} for npm tag ${releasePrerelease === 'true' ? 'next' : 'latest'}`)
