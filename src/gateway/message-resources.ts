/** Feishu message delivery and workspace resource support. */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/** Persist an upload without overwriting another message's file. */
export async function saveMessageResource(workspace: string, data: Uint8Array, fileName: string): Promise<string> {
  const dir = join(workspace, 'uploads')
  await mkdir(dir, { recursive: true })
  // Feishu filenames are untrusted; accept a filename, never a directory.
  // eslint-disable-next-line no-control-regex -- Strip control characters from external filenames.
  const safeName = basename(fileName.replaceAll('\\', '/')).replace(/[\x00-\x1f`]/gu, '_')
  const name = safeName === '' || safeName === '.' || safeName === '..' ? 'file' : safeName
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let index = 0; ; index += 1) {
    const path = join(dir, `${stem}${index === 0 ? '' : `-${String(index)}`}${extension}`)
    try {
      // Exclusive creation also handles concurrent uploads and existing symlinks.
      await writeFile(path, data, { flag: 'wx' })
      return path
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** Describe a persisted upload using an absolute path readable by dsh. */
export function fileMessageContent(path: string): { type: 'text'; text: string } {
  return { type: 'text', text: `A new file message uploaded to \`${path}\`` }
}
