export interface OperationResult {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data?: unknown
}

export function ok(message: string, data?: unknown): OperationResult {
  return { ok: true, code: 'ok', message, data }
}

export function fail(code: string, message: string): OperationResult {
  return { ok: false, code, message }
}
