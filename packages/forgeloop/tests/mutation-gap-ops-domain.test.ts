import { describe, expect, it } from 'vitest'
import {
  OPS_ACTIVE_STATES,
  OPS_RESOURCE_KINDS,
  OPS_SEVERITIES,
  actionArgv,
  isOpsActive,
  opsSignatureOf,
  validateOpsCatalog,
  type OpsCatalog,
} from '../src/domain/ops.js'

function catalog(overrides: Partial<OpsCatalog> = {}): OpsCatalog {
  return {
    resources: [{ id: 'web', kind: 'app' as never, label: '页面' }],
    checks: [
      {
        id: 'health',
        resourceId: 'web',
        command: ['true'],
        timeoutSeconds: 10,
        severity: 'major' as never,
      },
    ],
    actions: [
      {
        id: 'restart',
        resourceId: 'web',
        command: ['restart', '--mode', '{mode}'],
        params: [{ name: 'mode', values: ['safe', 'fast'] }],
        timeoutSeconds: 10,
        auto: true,
        verifyCheckId: 'health',
      },
    ],
    ...overrides,
  }
}

describe('ops catalog validation', () => {
  it('accepts a coherent catalog and exposes stable vocabularies', () => {
    expect(() => validateOpsCatalog(catalog())).not.toThrow()
    expect(isOpsActive('open')).toBe(true)
    expect(isOpsActive('closed')).toBe(false)
    expect(OPS_RESOURCE_KINDS).toContain('app')
    expect(OPS_SEVERITIES).toContain('major')
  })

  it('rejects invalid resources', () => {
    expect(() =>
      validateOpsCatalog(
        catalog({ resources: [{ id: 'bad id', kind: 'app' as never, label: 'x' }] }),
      ),
    ).toThrow('资源身份只能使用字母、数字、下划线和连字符："bad id"')
    expect(() =>
      validateOpsCatalog(
        catalog({ resources: [{ id: 'web', kind: 'nope' as never, label: 'x' }] }),
      ),
    ).toThrow('资源 web 的类型不受支持：nope')
    expect(() =>
      validateOpsCatalog(catalog({ resources: [{ id: 'web', kind: 'app' as never, label: ' ' }] })),
    ).toThrow('资源 web 缺少展示名称')
    expect(() =>
      validateOpsCatalog(
        catalog({
          resources: [
            { id: 'web', kind: 'app' as never, label: 'a' },
            { id: 'web', kind: 'app' as never, label: 'b' },
          ],
        }),
      ),
    ).toThrow('重复的资源身份：web')
  })

  it('rejects invalid checks', () => {
    const base = catalog().checks[0]!
    expect(() => validateOpsCatalog(catalog({ checks: [{ ...base, id: '-bad' }] }))).toThrow(
      '检查身份只能使用字母、数字、下划线和连字符："-bad"',
    )
    expect(() =>
      validateOpsCatalog(catalog({ checks: [{ ...base, resourceId: 'other' }] })),
    ).toThrow('检查 health 引用了未登记的资源：other')
    expect(() => validateOpsCatalog(catalog({ checks: [base, base] }))).toThrow(
      '重复的检查身份：health',
    )
    expect(() => validateOpsCatalog(catalog({ checks: [{ ...base, command: [] }] }))).toThrow(
      '检查 health的命令不能为空',
    )
    expect(() => validateOpsCatalog(catalog({ checks: [{ ...base, timeoutSeconds: 0 }] }))).toThrow(
      '检查 health 的超时必须是正数',
    )
    expect(() =>
      validateOpsCatalog(catalog({ checks: [{ ...base, severity: 'nope' as never }] })),
    ).toThrow('检查 health 的严重度不受支持：nope')
  })

  it('rejects invalid actions, params and placeholders', () => {
    const base = catalog().actions[0]!
    expect(() => validateOpsCatalog(catalog({ actions: [{ ...base, id: 'bad id' }] }))).toThrow(
      '动作身份只能使用字母、数字、下划线和连字符："bad id"',
    )
    expect(() =>
      validateOpsCatalog(catalog({ actions: [{ ...base, resourceId: 'other' }] })),
    ).toThrow('动作 restart 引用了未登记的资源：other')
    expect(() => validateOpsCatalog(catalog({ actions: [base, base] }))).toThrow(
      '重复的动作身份：restart',
    )
    expect(() =>
      validateOpsCatalog(catalog({ actions: [{ ...base, verifyCheckId: 'missing' }] })),
    ).toThrow('动作 restart 的恢复校验检查未登记：missing')
    expect(() =>
      validateOpsCatalog(
        catalog({
          actions: [{ ...base, command: ['restart'], params: [] }],
        }),
      ),
    ).not.toThrow()
    expect(() =>
      validateOpsCatalog(
        catalog({ actions: [{ ...base, params: [{ name: 'mode', values: [] }] }] }),
      ),
    ).toThrow('动作 restart 的参数 mode 缺少允许值')
    expect(() =>
      validateOpsCatalog(
        catalog({ actions: [{ ...base, params: [{ name: 'mode', values: ['a', 'a'] }] }] }),
      ),
    ).toThrow('动作 restart 的参数 mode 存在重复的允许值')
    expect(() =>
      validateOpsCatalog(
        catalog({
          actions: [
            { ...base, command: ['restart'], params: [{ name: 'mode', values: ['safe'] }] },
          ],
        }),
      ),
    ).toThrow('动作 restart 的参数 mode 未在命令中使用')
    expect(() =>
      validateOpsCatalog(
        catalog({ actions: [{ ...base, command: ['restart', '{nope}'], params: [] }] }),
      ),
    ).toThrow('动作 restart 的命令引用了未声明的参数 {nope}')
  })
})

describe('action argv and signatures', () => {
  it('substitutes declared params and rejects unknown or out-of-range values', () => {
    const action = catalog().actions[0]!
    expect(actionArgv(action, { mode: 'safe' })).toEqual(['restart', '--mode', 'safe'])
    expect(() => actionArgv(action, { mode: 'nope' })).toThrow(
      '动作 restart 的参数 mode 取值 "nope" 不在允许值内',
    )
    expect(() => actionArgv(action, { other: 'x' })).toThrow('动作 restart 未登记参数：other')
    expect(() => actionArgv(action, {})).toThrow('动作 restart 缺少参数：mode')
  })

  it('builds stable signatures and requires fresh state for recovery', () => {
    expect(
      opsSignatureOf({ resourceId: 'web', checkId: 'health', exitCode: 0, output: ' a  b ' }),
    ).toMatch(/^web\/health\/0\/[0-9a-f]{12}$/)
    expect(
      opsSignatureOf({ resourceId: 'web', checkId: 'health', exitCode: 0, output: 'a b' }),
    ).toBe(
      opsSignatureOf({ resourceId: 'web', checkId: 'health', exitCode: 0, output: '  a   b  ' }),
    )
    expect(isOpsActive('recovering')).toBe(true)
    expect(OPS_ACTIVE_STATES.has('closed')).toBe(false)
  })
})
