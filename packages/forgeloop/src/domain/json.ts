export function parseJsonArray(text: string): unknown[] {
  const value: unknown = JSON.parse(text)
  return Array.isArray(value) ? value : []
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
