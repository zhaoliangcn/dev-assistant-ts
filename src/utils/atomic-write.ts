import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 原子文件写入：先写同目录临时文件，再 rename 覆盖目标。
 * 保证目标文件要么是旧内容、要么是新内容，不会出现半写状态。
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, filePath)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}
