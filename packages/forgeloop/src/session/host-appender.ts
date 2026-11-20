import { asRecord } from '../domain/json.js'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export type SessionAppender = (
  session: unknown,
  type: string,
  data: Record<string, unknown>,
) => unknown

function isSessionAppender(value: unknown): value is SessionAppender {
  return typeof value === 'function'
}

export async function resolveHostSessionAppender(): Promise<SessionAppender | undefined> {
  try {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    const requireFromDsh = createRequire(entry)
    const sessionModule: unknown = await import(
      pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session')).href
    )
    const candidate = asRecord(sessionModule)?.appendPluginRecord
    return isSessionAppender(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}
