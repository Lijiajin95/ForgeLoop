import { parseJsonObject } from '../domain/json.js'
import { readFileSync } from 'node:fs'

function readVersion(): string {
  try {
    const path = new URL('../../package.json', import.meta.url)
    const data = parseJsonObject(readFileSync(path, 'utf8'))
    return typeof data.version === 'string' ? data.version : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export const PLUGIN_VERSION = readVersion()
