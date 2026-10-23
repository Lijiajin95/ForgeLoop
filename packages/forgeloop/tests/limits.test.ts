import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMIT_SECONDS, ExecutionBudget } from '../src/domain/limits.js'

describe('execution budget', () => {
  it('rejects a non-positive or non-finite limit', () => {
    expect(() => new ExecutionBudget(0)).toThrow('执行限额必须为正数')
    expect(() => new ExecutionBudget(-5)).toThrow('执行限额必须为正数')
    expect(() => new ExecutionBudget(Number.NaN)).toThrow('执行限额必须为正数')
    expect(() => new ExecutionBudget(Number.POSITIVE_INFINITY)).toThrow('执行限额必须为正数')
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
    expect(new ExecutionBudget(DEFAULT_LIMIT_SECONDS).limitSeconds).toBe(DEFAULT_LIMIT_SECONDS)
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
})
