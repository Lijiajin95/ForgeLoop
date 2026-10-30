import { describe, expect, it } from 'vitest'
import {
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_RECOVERED,
  OPS_UNRESOLVED,
  actionArgv,
  authorizeOpsAction,
  opsSignatureOf,
  opsStats,
  parseOpsDiagnosis,
  parseOpsInterruptionReport,
  recoveryPassed,
  validateOpsCatalog,
  type OpsAction,
  type OpsCatalog,
  type OpsDiagnosis,
} from '../src/domain/ops.js'

const CATALOG: OpsCatalog = {
  resources: [
    { id: 'web', kind: 'app', label: '天工页面' },
    { id: 'db', kind: 'database', label: '业务库' },
  ],
  checks: [
    { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'], timeoutSeconds: 20, severity: 'major' },
    { id: 'db-ping', resourceId: 'db', command: ['node', '-e', 'process.exit(0)'], timeoutSeconds: 20, severity: 'critical' },
  ],
  actions: [
    {
      id: 'restart-web',
      resourceId: 'web',
      command: ['node', '-e', 'process.exit(0)', '--', '{mode}'],
      params: [{ name: 'mode', values: ['graceful', 'force'] }],
      timeoutSeconds: 30,
      auto: true,
      verifyCheckId: 'web-health',
    },
    {
      id: 'restart-db',
      resourceId: 'db',
      command: ['node', '-e', 'process.exit(0)'],
      params: [],
      timeoutSeconds: 30,
      auto: false,
      verifyCheckId: 'db-ping',
    },
  ],
}

function diagnosis(overrides: Partial<OpsDiagnosis> = {}): OpsDiagnosis {
  return {
    impact: '用户无法打开天工页',
    facts: ['健康检查退出码 1'],
    hypotheses: [{ statement: '进程已退出', confidence: 'medium' }],
    proposedAction: { actionId: 'restart-web', params: { mode: 'graceful' } },
    decisionRequired: false,
    fixRequired: false,
    summary: '先重启进程恢复服务',
    ...overrides,
  }
}

describe('ops catalog validation', () => {
  it('accepts a registered resource, check and action catalog', () => {
    expect(() => validateOpsCatalog(CATALOG)).not.toThrow()
  })

  it('rejects duplicate ids and unknown resource references', () => {
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        resources: [...CATALOG.resources, CATALOG.resources[0]!],
      }),
    ).toThrow('重复')
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        checks: [{ ...CATALOG.checks[0]!, resourceId: 'missing' }],
      }),
    ).toThrow('未登记的资源')
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        actions: [{ ...CATALOG.actions[0]!, verifyCheckId: 'missing' }],
      }),
    ).toThrow('恢复校验检查')
  })

  it('rejects a placeholder without a declared parameter and an unused parameter', () => {
    const action = CATALOG.actions[0]!
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        actions: [{ ...action, command: ['node', '-e', 'process.exit(0)', '{other}'] }],
      }),
    ).toThrow('未声明的参数')
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        actions: [{ ...action, command: ['node', '-e', 'process.exit(0)'] }],
      }),
    ).toThrow('未在命令中使用')
  })

  it('rejects an empty parameter value set or a duplicated parameter', () => {
    const action = CATALOG.actions[0]!
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        actions: [{ ...action, params: [{ name: 'mode', values: [] }] }],
      }),
    ).toThrow('允许值')
    expect(() =>
      validateOpsCatalog({
        ...CATALOG,
        actions: [
          {
            ...action,
            params: [
              { name: 'mode', values: ['graceful'] },
              { name: 'mode', values: ['force'] },
            ],
          },
        ],
      }),
    ).toThrow('重复')
  })
})

describe('registered action invocation', () => {
  const action = CATALOG.actions[0]!

  it('substitutes only enumerated parameter values into the registered argv', () => {
    expect(actionArgv(action, { mode: 'force' })).toEqual([
      'node',
      '-e',
      'process.exit(0)',
      '--',
      'force',
    ])
  })

  it('rejects missing, unknown and non-enumerated values', () => {
    expect(() => actionArgv(action, {})).toThrow('缺少参数')
    expect(() => actionArgv(action, { mode: 'force', extra: 'x' })).toThrow('未登记')
    expect(() => actionArgv(action, { mode: 'rm -rf /' })).toThrow('不在允许值')
  })
})

describe('failure signature and recovery verdict', () => {
  it('merges identical failures and separates different output', () => {
    const base = {
      resourceId: 'web',
      checkId: 'web-health',
      exitCode: 1,
      output: 'Error: connect ECONNREFUSED 127.0.0.1:3080\n    at ...',
    }
    expect(opsSignatureOf(base)).toBe(opsSignatureOf({ ...base }))
    expect(opsSignatureOf(base)).not.toBe(
      opsSignatureOf({ ...base, output: 'Error: timeout after 5000ms' }),
    )
    expect(opsSignatureOf(base)).not.toBe(opsSignatureOf({ ...base, exitCode: 2 }))
  })

  it('treats only exit code 0 as passed recovery', () => {
    expect(recoveryPassed({ code: 0, timedOut: false })).toBe(true)
    expect(recoveryPassed({ code: 1, timedOut: false })).toBe(false)
    expect(recoveryPassed({ code: 0, timedOut: true })).toBe(false)
  })
})

describe('ops diagnosis parsing', () => {
  it('parses facts, hypotheses and a registered-action proposal', () => {
    const parsed = parseOpsDiagnosis(
      JSON.stringify({
        impact: '用户无法打开天工页',
        facts: ['健康检查退出码 1'],
        hypotheses: [{ statement: '进程已退出', confidence: 'medium' }],
        proposed_action: { action_id: 'restart-web', params: { mode: 'graceful' } },
        decision_required: false,
        fix_required: true,
        summary: '先重启进程恢复服务',
      }),
    )
    expect(parsed).toEqual(diagnosis({ fixRequired: true }))
  })

  it('accepts no proposed action and rejects malformed structures', () => {
    const parsed = parseOpsDiagnosis(
      JSON.stringify({
        impact: '日志显示磁盘已满',
        facts: [],
        hypotheses: [],
        proposed_action: null,
        decision_required: true,
        fix_required: false,
        summary: '需要人工确认是否扩容',
      }),
    )
    expect(parsed.proposedAction).toBeNull()
    expect(parsed.decisionRequired).toBe(true)

    expect(() => parseOpsDiagnosis('not json')).toThrow()
    expect(() =>
      parseOpsDiagnosis(
        JSON.stringify({
          impact: '',
          facts: [],
          hypotheses: [],
          proposed_action: null,
          decision_required: true,
          fix_required: false,
          summary: 'x',
        }),
      ),
    ).toThrow('影响')
    expect(() =>
      parseOpsDiagnosis(
        JSON.stringify({
          impact: 'x',
          facts: [],
          hypotheses: [{ statement: 'y', confidence: 'certain' }],
          proposed_action: null,
          decision_required: true,
          fix_required: false,
          summary: 'x',
        }),
      ),
    ).toThrow('置信度')
  })
})

describe('action authorization', () => {
  const webAction: OpsAction = CATALOG.actions[0]!
  const event = {
    resourceId: 'web',
    severity: 'major' as const,
    state: OPS_AWAITING_DECISION,
  }

  it('allows a registered auto action when the model does not require a decision', () => {
    expect(authorizeOpsAction({ event, action: webAction, diagnosis: diagnosis() })).toEqual({
      auto: true,
      source: 'ops-action:auto:restart-web',
      reason: '',
    })
  })

  it('keeps every other case with the owner', () => {
    expect(
      authorizeOpsAction({ event, action: webAction, diagnosis: diagnosis({ decisionRequired: true }) }).auto,
    ).toBe(false)
    expect(
      authorizeOpsAction({
        event,
        action: CATALOG.actions[1]!,
        diagnosis: diagnosis({ proposedAction: { actionId: 'restart-db', params: {} } }),
      }).auto,
    ).toBe(false)
    expect(
      authorizeOpsAction({
        event: { ...event, resourceId: 'db' },
        action: webAction,
        diagnosis: diagnosis(),
      }).auto,
    ).toBe(false)
  })
})

describe('ops statistics', () => {
  it('counts independent events, human involvement and outcomes', () => {
    const stats = opsStats([
      {
        state: OPS_RECOVERED,
        humanInvolved: false,
        openedAt: '2026-10-01T00:00:00.000Z',
        recoveredAt: '2026-10-01T00:05:00.000Z',
        fixRequirementId: '',
      },
      {
        state: OPS_RECOVERED,
        humanInvolved: true,
        openedAt: '2026-10-01T01:00:00.000Z',
        recoveredAt: '2026-10-01T01:10:00.000Z',
        fixRequirementId: 'req-1',
      },
      {
        state: OPS_UNRESOLVED,
        humanInvolved: true,
        openedAt: '2026-10-01T02:00:00.000Z',
        recoveredAt: '',
        fixRequirementId: 'req-2',
      },
      {
        state: OPS_UNRESOLVED,
        humanInvolved: false,
        openedAt: '2026-10-01T03:00:00.000Z',
        recoveredAt: '',
        fixRequirementId: '',
      },
      {
        state: OPS_CLOSED,
        humanInvolved: true,
        openedAt: '2026-10-01T04:00:00.000Z',
        recoveredAt: '',
        fixRequirementId: '',
      },
    ])
    expect(stats.total).toBe(5)
    expect(stats.humanInvolved).toBe(3)
    expect(stats.recovered).toBe(2)
    expect(stats.unresolved).toBe(2)
    expect(stats.fixRequirements).toBe(2)
    expect(stats.averageRecoverySeconds).toBe(450)
  })
})

describe('ops interruption report', () => {
  it('parses a bounded root-cause report for an interrupted action', () => {
    const report = parseOpsInterruptionReport(
      JSON.stringify({
        summary: '动作被宿主中断，没有退出码',
        root_cause: '日志只记录到动作启动，没有退出码；无法判断重启是否生效',
        evidence: ['动作 restart-web 在 10:00 开始', '没有退出码', '没有恢复复核结果'],
        next_step: '人工检查 Web 进程与健康检查，再决定是否重试',
      }),
    )
    expect(report.summary).toContain('中断')
    expect(report.evidence).toHaveLength(3)
    expect(report.nextStep).toContain('人工')
  })

  it('rejects missing, empty and oversized report fields instead of storing a guess', () => {
    expect(() => parseOpsInterruptionReport('not json')).toThrow()
    expect(() => parseOpsInterruptionReport(JSON.stringify([]))).toThrow(/JSON 对象/)
    expect(() =>
      parseOpsInterruptionReport(
        JSON.stringify({ summary: '', root_cause: 'x', evidence: ['y'], next_step: 'z' }),
      ),
    ).toThrow(/结论/)
    expect(() =>
      parseOpsInterruptionReport(
        JSON.stringify({ summary: 'x', root_cause: 'y', evidence: [], next_step: 'z' }),
      ),
    ).toThrow(/至少需要一条事实/)
    expect(() =>
      parseOpsInterruptionReport(
        JSON.stringify({
          summary: 'x',
          root_cause: 'y',
          evidence: Array.from({ length: 21 }, (_, index) => `fact-${index}`),
          next_step: 'z',
        }),
      ),
    ).toThrow(/20/)
    expect(() =>
      parseOpsInterruptionReport(
        JSON.stringify({ summary: 'x'.repeat(501), root_cause: 'y', evidence: ['z'], next_step: 'w' }),
      ),
    ).toThrow(/500/)
    expect(() =>
      parseOpsInterruptionReport(
        JSON.stringify({ summary: 'x', root_cause: 'y', evidence: ['z'], next_step: 'w'.repeat(2001) }),
      ),
    ).toThrow(/2000/)
  })
})
