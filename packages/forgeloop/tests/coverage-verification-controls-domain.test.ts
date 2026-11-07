import { describe, expect, it } from 'vitest'
import {
  controlPatchTargets,
  parseVerificationControls,
  validateControlCoverage,
  validateControlPatch,
} from '../src/domain/verification-controls.js'

const patch = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-export const ok = true',
  '+export const ok = false',
].join('\n')

describe('control manifest parsing', () => {
  it('rejects manifests that are not an object or lack a controls array', () => {
    expect(() => parseVerificationControls('[]')).toThrow('敏感性对照必须是 JSON 对象')
    expect(() => parseVerificationControls('{}')).toThrow('敏感性对照必须给出 controls 数组')
    expect(() => parseVerificationControls('{"controls":{}}')).toThrow('必须给出 controls 数组')
  })

  it('rejects more than twenty controls', () => {
    const controls = Array.from({ length: 21 }, (_, index) => ({
      label: `check-${index}`,
      patch: 'verification/controls/x.patch',
      expected_failure_output: '业务规则不满足预期',
    }))
    expect(() => parseVerificationControls(JSON.stringify({ controls }))).toThrow(
      '敏感性对照一次最多 20 条',
    )
  })

  it('rejects non-object entries, empty labels and relative path escapes', () => {
    const base = {
      patch: 'verification/controls/a.patch',
      expected_failure_output: '业务规则不满足预期',
    }
    expect(() => parseVerificationControls(JSON.stringify({ controls: ['x'] }))).toThrow(
      'controls[0] 必须是 JSON 对象',
    )
    expect(() =>
      parseVerificationControls(JSON.stringify({ controls: [{ ...base, label: '  ' }] })),
    ).toThrow('controls[0].label 必须是非空字符串')
    for (const patchPath of [
      '/etc/x.patch',
      '../x.patch',
      'src/x.patch',
      'verification/controls/x.txt',
    ]) {
      expect(() =>
        parseVerificationControls(
          JSON.stringify({ controls: [{ ...base, label: 'check-1', patch: patchPath }] }),
        ),
      ).toThrow('敏感性对照补丁')
    }
  })

  it('requires a distinguishable failure output of at least eight characters', () => {
    const base = { label: 'check-1', patch: 'verification/controls/a.patch' }
    expect(() =>
      parseVerificationControls(
        JSON.stringify({ controls: [{ ...base, expected_failure_output: '太短' }] }),
      ),
    ).toThrow('至少 8 个字符')
    expect(() =>
      parseVerificationControls(
        JSON.stringify({ controls: [{ ...base, expected_failure_output: '' }] }),
      ),
    ).toThrow('expected_failure_output 必须是非空字符串')
    const parsed = parseVerificationControls(
      JSON.stringify({
        controls: [
          { ...base, expected_failure_output: '业务规则不满足预期' },
          {
            label: 'check-2',
            patch: 'verification/controls/b.patch',
            expectedFailureOutput: ' 也算合法的失败原文 ',
          },
        ],
      }),
    )
    expect(parsed.map((item) => [item.label, item.expectedFailureOutput])).toEqual([
      ['check-1', '业务规则不满足预期'],
      ['check-2', '也算合法的失败原文'],
    ])
  })

  it('rejects duplicate labels', () => {
    const entry = {
      label: 'check-1',
      patch: 'verification/controls/a.patch',
      expected_failure_output: '业务规则不满足预期',
    }
    expect(() => parseVerificationControls(JSON.stringify({ controls: [entry, entry] }))).toThrow(
      '敏感性对照的 label 不能重复：check-1',
    )
  })
})

describe('control coverage', () => {
  it('does not blame missing controls when no required scenario passed', () => {
    expect(
      validateControlCoverage({
        requiredScenarios: ['主路径'],
        reportScenarios: [{ scenario: '主路径', status: 'fail', commands: ['check-1'] }],
        controls: [],
      }),
    ).toEqual([])
  })

  it('requires at least one passing required scenario to own a control', () => {
    const issues = validateControlCoverage({
      requiredScenarios: ['主路径'],
      reportScenarios: [{ scenario: '主路径', status: 'pass', commands: ['check-1'] }],
      controls: [{ label: 'check-2' }],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('没有任何必过场景提供敏感性对照')
    expect(
      validateControlCoverage({
        requiredScenarios: ['主路径'],
        reportScenarios: [{ scenario: '主路径', status: 'pass', commands: ['check-1'] }],
        controls: [{ label: 'check-1' }],
      }),
    ).toEqual([])
  })
})

describe('control patch validation', () => {
  it('reads targets from diff headers and ignores /dev/null', () => {
    expect(controlPatchTargets(patch)).toEqual(['src/app.ts'])
    expect(
      controlPatchTargets('+++ b/src/new.ts\n+++ /dev/null\ndiff --git a/x.ts b/x.ts'),
    ).toEqual(['src/new.ts', 'x.ts'])
    expect(controlPatchTargets('no headers here')).toEqual([])
  })

  it('rejects patches without targets, escapes and test-only changes', () => {
    expect(validateControlPatch('nothing')).toEqual(['敏感性对照补丁没有可识别的目标文件'])
    expect(validateControlPatch('+++ b/../outside.ts')).toEqual([
      '敏感性对照补丁路径越界：../outside.ts',
    ])
    expect(validateControlPatch('+++ b//abs.ts')).toEqual(['敏感性对照补丁路径越界：/abs.ts'])
    expect(validateControlPatch('+++ b/verification/check.js')).toEqual([
      '敏感性对照不能只修改验证材料，必须触及业务实现：verification/check.js',
    ])
    expect(validateControlPatch(patch)).toEqual([])
  })
})
