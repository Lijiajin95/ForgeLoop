/**
 * 属性测试的统一运行参数。
 *
 * - 每项 PR 至少 200 次；nightly 可用 FORGELOOP_PROPERTY_RUNS 放大。
 * - 固定 seed 复现：FORGELOOP_PROPERTY_SEED=<seed> npx vitest run <file>。
 * - 失败时 fast-check 会打印 seed 与 shrink 后的反例；verbose 模式可看全部失败样本。
 */
import fc from 'fast-check'

export const MIN_PROPERTY_RUNS = 200

export function propertyNumRuns(): number {
  const raw = process.env.FORGELOOP_PROPERTY_RUNS
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(parsed) || parsed < MIN_PROPERTY_RUNS) return MIN_PROPERTY_RUNS
  return parsed
}

export function propertySeed(): number | undefined {
  const raw = process.env.FORGELOOP_PROPERTY_SEED
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/** 统一的 assert 参数：固定 seed、最小 200 次，失败时打印 seed 与反例。 */
export function propertyOptions(numRuns: number = propertyNumRuns()): fc.Parameters<unknown> {
  const seed = propertySeed()
  const options: fc.Parameters<unknown> = {
    numRuns,
    verbose: process.env.FORGELOOP_PROPERTY_VERBOSE === '1',
  }
  return seed === undefined ? options : { ...options, seed }
}
