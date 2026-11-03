import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMIT_SECONDS,
  ExecutionBudget,
  UNLIMITED,
  isLimitSeconds,
} from '../src/domain/limits.js'

describe('execution budget', () => {
  it('rejects zero, other negative numbers and non-finite limits', () => {
    expect(() => new ExecutionBudget(0)).toThrow('执行限额必须为正数或 -1（不限）')
    expect(() => new ExecutionBudget(-5)).toThrow('执行限额必须为正数或 -1（不限）')
    expect(() => new ExecutionBudget(Number.NaN)).toThrow('执行限额必须为正数或 -1（不限）')
    expect(() => new ExecutionBudget(Number.POSITIVE_INFINITY)).toThrow(
      '执行限额必须为正数或 -1（不限）',
    )
    expect(isLimitSeconds(-1)).toBe(true)
    expect(isLimitSeconds(60)).toBe(true)
    expect(isLimitSeconds(0)).toBe(false)
  })

  it('rejects negative or non-finite prior consumption', () => {
    expect(() => new ExecutionBudget(60, -1)).toThrow('已消耗时间不能为负')
    expect(() => new ExecutionBudget(60, Number.NaN)).toThrow('已消耗时间不能为负')
  })

  it('exposes the configured limit, consumption and remaining time', () => {
    const budget = new ExecutionBudget(60, 20)
    expect(budget.limitSeconds).toBe(60)
    expect(budget.consumedSeconds).toBe(20)
    expect(budget.remainingSeconds).toBe(40)
    expect(budget.exhausted).toBe(false)
    expect(budget.canStartAction()).toBe(true)
    expect(new ExecutionBudget(DEFAULT_LIMIT_SECONDS).limitSeconds).toBe(UNLIMITED)
  })

  it('never stops starting actions when the limit is unlimited', () => {
    const budget = new ExecutionBudget(UNLIMITED, 100_000)
    expect(budget.unlimited).toBe(true)
    expect(budget.remainingSeconds).toBe(Number.POSITIVE_INFINITY)
    expect(budget.exhausted).toBe(false)
    expect(budget.canStartAction()).toBe(true)
    budget.charge(3600)
    expect(budget.consumedSeconds).toBe(103_600)
    expect(budget.canStartAction()).toBe(true)
    budget.extend(60)
    expect(budget.limitSeconds).toBe(UNLIMITED)
  })

  it('never reports negative remaining time and stops new actions when exhausted', () => {
    const budget = new ExecutionBudget(30, 30)
    expect(budget.remainingSeconds).toBe(0)
    expect(budget.exhausted).toBe(true)
    expect(budget.canStartAction()).toBe(false)
    const overrun = new ExecutionBudget(30, 45)
    expect(overrun.remainingSeconds).toBe(0)
    expect(overrun.exhausted).toBe(true)
  })

  it('accumulates only finite non-negative execution seconds', () => {
    const budget = new ExecutionBudget(60, 10)
    budget.charge(5)
    expect(budget.consumedSeconds).toBe(15)
    expect(() => budget.charge(-1)).toThrow('计入的执行时长不能为负')
    expect(() => budget.charge(Number.NaN)).toThrow('计入的执行时长不能为负')
    expect(budget.consumedSeconds).toBe(15)
  })

  it('extends the limit without clearing consumption', () => {
    const budget = new ExecutionBudget(30, 20)
    budget.extend(120)
    expect(budget.limitSeconds).toBe(120)
    expect(budget.consumedSeconds).toBe(20)
    expect(budget.remainingSeconds).toBe(100)
    expect(() => budget.extend(20)).toThrow('延长后的限额必须大于已经消耗的时间')
    expect(budget.limitSeconds).toBe(120)
  })

  it('can be extended to unlimited without clearing consumption', () => {
    const budget = new ExecutionBudget(30, 40)
    budget.extend(UNLIMITED)
    expect(budget.limitSeconds).toBe(UNLIMITED)
    expect(budget.consumedSeconds).toBe(40)
    expect(budget.canStartAction()).toBe(true)
  })
})
