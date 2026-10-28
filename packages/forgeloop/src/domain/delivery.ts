/** 候选、测试日志与交付材料共用的 SHA-256 计算。 */

import { createHash } from 'node:crypto'

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
