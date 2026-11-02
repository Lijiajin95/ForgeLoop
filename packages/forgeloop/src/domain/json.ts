/** 把 JSON 文本解析成数组；非数组返回空数组，调用方按缺失项处理。 */
export function parseJsonArray(text: string): unknown[] {
  const value: unknown = JSON.parse(text)
  return Array.isArray(value) ? value : []
}

/** 把未知值收窄为记录；非对象（数组、标量、null）返回 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 把 JSON 文本解析成对象；非对象（数组、标量、null）返回空对象，调用方按缺失字段处理。 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
