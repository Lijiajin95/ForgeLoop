import { describe, expect, it } from 'vitest'
import {
  parseBusinessReview,
  validateBusinessReview,
  type BusinessReview,
} from '../src/domain/business-review.js'

/**
 * 业务终审材料的结构与覆盖规则：模型输出必须可解析、可核对；
 * 缺项、改写、引用未执行命令或证据不在输出里都无法通过。
 */

const SCENARIO = '客户提交需求后自动分析'
const CRITERION = '分析结果写入需求记录'
const OUTPUT = 'analysis stored: req-1'

function review(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: '业务场景复核通过',
    findings: [],
    blocking: [],
    scenarios: [
      {
        scenario: SCENARIO,
        status: 'pass',
        evidence: OUTPUT,
        commands: ['smoke'],
      },
    ],
    acceptance: [
      {
        criterion: CRITERION,
        status: 'pass',
        evidence: OUTPUT,
        commands: ['smoke'],
      },
    ],
    ...overrides,
  })
}

const runs = [{ label: 'smoke', output: `cmd\n${OUTPUT}\ndone` }]

describe('business review material parsing', () => {
  it('parses a passing review with scenarios and acceptance items', () => {
    const parsed = parseBusinessReview(review())
    expect(parsed.verdict).toBe('pass')
    expect(parsed.scenarios[0]).toMatchObject({ text: SCENARIO, status: 'pass', evidence: OUTPUT })
    expect(parsed.acceptance[0]).toMatchObject({ text: CRITERION, status: 'pass' })
  })

  it('rejects non-object, unknown verdict and contradictory blocking', () => {
    expect(() => parseBusinessReview('[]')).toThrow('必须是 JSON 对象')
    expect(() => parseBusinessReview(review({ verdict: 'ok' }))).toThrow('结论必须是 pass 或 block')
    expect(() =>
      parseBusinessReview(review({ verdict: 'pass', blocking: ['有问题'] })),
    ).toThrow('blocking 必须为空')
    expect(() => parseBusinessReview(review({ verdict: 'block', blocking: [] }))).toThrow(
      '至少一条阻断原因',
    )
  })

  it('rejects missing or malformed lists and items', () => {
    expect(() => parseBusinessReview(review({ scenarios: undefined }))).toThrow('scenarios 数组')
    expect(() => parseBusinessReview(review({ acceptance: undefined }))).toThrow('acceptance 数组')
    expect(() => parseBusinessReview(review({ summary: ' ' }))).toThrow('summary')
    expect(() => parseBusinessReview(review({ findings: [1] }))).toThrow('findings')
    expect(() =>
      parseBusinessReview(
        review({
          scenarios: [{ scenario: ' ', status: 'pass', evidence: OUTPUT, commands: ['smoke'] }],
        }),
      ),
    ).toThrow('scenario')
    expect(() =>
      parseBusinessReview(
        review({
          scenarios: [{ scenario: SCENARIO, status: 'maybe', evidence: OUTPUT, commands: [] }],
        }),
      ),
    ).toThrow('status')
    expect(() =>
      parseBusinessReview(
        review({
          scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: 1, commands: [1] }],
        }),
      ),
    ).toThrow('commands')
  })

  it('accepts block verdicts with at least one blocking reason', () => {
    const parsed = parseBusinessReview(
      review({ verdict: 'block', blocking: ['关键场景未复现'] }),
    )
    expect(parsed.verdict).toBe('block')
    expect(parsed.blocking).toEqual(['关键场景未复现'])
  })
})

describe('business review coverage validation', () => {
  const base: BusinessReview = parseBusinessReview(review())

  it('passes when every item quotes the verification output', () => {
    expect(
      validateBusinessReview({
        scenarios: [SCENARIO],
        acceptanceCriteria: [CRITERION],
        review: base,
        runs,
      }),
    ).toEqual([])
  })

  it('blocks a review whose verdict is block', () => {
    const blocked = parseBusinessReview(review({ verdict: 'block', blocking: ['未通过'] }))
    expect(
      validateBusinessReview({
        scenarios: [SCENARIO],
        acceptanceCriteria: [CRITERION],
        review: blocked,
        runs,
      })[0],
    ).toContain('业务终审结论为 block')
  })

  it('blocks missing scenarios and acceptance criteria', () => {
    const issues = validateBusinessReview({
      scenarios: [SCENARIO, '另一个场景'],
      acceptanceCriteria: [CRITERION, '另一个标准'],
      review: base,
      runs,
    })
    expect(issues).toContain(`业务终审缺少业务场景：另一个场景`)
    expect(issues).toContain(`业务终审缺少验收标准：另一个标准`)
  })

  it('blocks non-pass items, items without commands and unknown command labels', () => {
    const notVerified = parseBusinessReview(
      review({
        scenarios: [
          { scenario: SCENARIO, status: 'not_verified', evidence: OUTPUT, commands: ['smoke'] },
        ],
      }),
    )
    expect(
      validateBusinessReview({
        scenarios: [SCENARIO],
        acceptanceCriteria: [],
        review: notVerified,
        runs,
      })[0],
    ).toContain('未通过')

    const noCommand = parseBusinessReview(
      review({
        scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: OUTPUT, commands: [] }],
      }),
    )
    expect(
      validateBusinessReview({
        scenarios: [SCENARIO],
        acceptanceCriteria: [],
        review: noCommand,
        runs,
      })[0],
    ).toContain('没有关联验证命令')

    const unknownCommand = parseBusinessReview(
      review({
        scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: OUTPUT, commands: ['other'] }],
      }),
    )
    expect(
      validateBusinessReview({
        scenarios: [SCENARIO],
        acceptanceCriteria: [],
        review: unknownCommand,
        runs,
      })[0],
    ).toContain('引用了未执行的验证命令')
  })

  it('blocks evidence that cannot be found in the cited command output', () => {
    const fabricated = parseBusinessReview(
      review({
        acceptance: [
          { criterion: CRITERION, status: 'pass', evidence: '人工确认无问题', commands: ['smoke'] },
        ],
      }),
    )
    expect(
      validateBusinessReview({
        scenarios: [SCENARIO],
        acceptanceCriteria: [CRITERION],
        review: fabricated,
        runs,
      }),
    ).toContain(`业务终审验收标准证据无法在验证输出中核对：${CRITERION}`)
  })
})
