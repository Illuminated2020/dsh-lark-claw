import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { saveMessageResource } from '../../src/gateway/message-resources.ts'

const workspaces: string[] = []
afterEach(async () => {
  for (const path of workspaces.splice(0)) await rm(path, { recursive: true, force: true })
})

it('keeps concurrent duplicate uploads intact and confines filenames to uploads', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-resources-'))
  workspaces.push(workspace)
  const paths = await Promise.all(['first', 'second'].map(text => saveMessageResource(workspace, Buffer.from(text), '../../report.pdf')))
  expect(new Set(paths).size).toBe(2)
  expect((await readdir(join(workspace, 'uploads'))).sort()).toEqual(['report-1.pdf', 'report.pdf'])
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(['first', 'second'])
  const windowsPath = await saveMessageResource(workspace, Buffer.from('third'), '..\\..\\report.pdf')
  expect(windowsPath).toBe(join(workspace, 'uploads', 'report-2.pdf'))
})
