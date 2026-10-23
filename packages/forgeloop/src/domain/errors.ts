/**
 * 领域错误：调用方据此区分“规则拒绝”“未找到”“畸形数据”和“额度用尽”。
 * 与旧实现一致：规则拒绝 fail-closed，不把畸形输入当成空结果。
 */

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