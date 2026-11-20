export class ForgeLoopError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

export class RuleViolationError extends ForgeLoopError {
  constructor(message: string) {
    super('rule_violation', message)
  }
}

export class NotFoundError extends ForgeLoopError {
  constructor(message: string) {
    super('not_found', message)
  }
}

export class MalformedError extends ForgeLoopError {
  constructor(message: string) {
    super('malformed', message)
  }
}

export class GrantExhaustedError extends ForgeLoopError {
  constructor(message: string) {
    super('grant_exhausted', message)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
