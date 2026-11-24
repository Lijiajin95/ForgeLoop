import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import {
  parseSpecFields,
  requirementStageGaps,
  validateSpec,
  type AnalysisSpec,
} from '../src/domain/spec.js'

const point = (overrides: Record<string, unknown> = {}) => ({
  id: 'BP-1',
  basis: 'user_requirement',
  source: '订单页按状态筛选',
  actor: '店长',
  trigger: '打开订单列表时',
  behavior: '按状态筛选订单',
  rules: ['只有店长可以批量取消订单'],
  exceptions: { status: 'assessed', items: ['支付回调延迟时订单保持待确认'], reason: '' },
  ...overrides,
})

const acceptance = (overrides: Record<string, unknown> = {}) => ({
  id: 'AC-1',
  point_ids: ['BP-1'],
  given: '订单列表存在三种状态的订单',
  when: '店长选择“已完成”筛选',
  then: '列表只显示已完成的订单',
  ...overrides,
})

const quality = (overrides: Record<string, unknown> = {}) => ({
  id: 'QA-1',
  kind: 'performance',
  metric: '订单列表首屏加载时间',
  target: 'P95 ≤ 2 秒',
  measure: '验证阶段用压测脚本取 P95',
  point_ids: ['BP-1'],
  acceptance_ids: ['AC-1'],
  ...overrides,
})

const dataRequirement = (overrides: Record<string, unknown> = {}) => ({
  id: 'DATA-1',
  entity: '订单',
  fields: [{ name: 'status', type: 'enum', constraints: 'pending/completed/cancelled' }],
  retention: '订单取消后保留 1 年',
  pii: false,
  point_ids: ['BP-1'],
  acceptance_ids: ['AC-1'],
  ...overrides,
})

const parsed = (overrides: Record<string, unknown> = {}) =>
  parseSpecFields({
    business_points: [point()],
    acceptance_criteria: [acceptance()],
    ...overrides,
  })

function specOf(overrides: Partial<AnalysisSpec> = {}): AnalysisSpec {
  const fields = parsed()
  return {
    points: fields.points,
    acceptance: fields.acceptance,
    assumptions: [],
    conflicts: [],
    references: [],
    uiMap: [],
    samples: [],
    quality: [],
    data: [],
    ...overrides,
  }
}

function validate(
  spec: AnalysisSpec,
  input: { inputKind?: 'requirement' | 'problem'; complete?: boolean } = {},
) {
  validateSpec({
    spec,
    complete: input.complete ?? true,
    inputKind: input.inputKind ?? 'requirement',
    requirementTexts: ['订单页按状态筛选'],
  })
}

describe('engineering spec artifacts', () => {
  it('parses quality attributes and data requirements into camel case fields', () => {
    const fields = parsed({
      quality_attributes: [quality()],
      data_requirements: [dataRequirement()],
    })
    expect(fields.quality).toEqual([
      {
        id: 'QA-1',
        kind: 'performance',
        metric: '订单列表首屏加载时间',
        target: 'P95 ≤ 2 秒',
        measure: '验证阶段用压测脚本取 P95',
        pointIds: ['BP-1'],
        acceptanceIds: ['AC-1'],
      },
    ])
    expect(fields.data[0]).toMatchObject({
      id: 'DATA-1',
      entity: '订单',
      pii: false,
      pointIds: ['BP-1'],
      fields: [{ name: 'status', type: 'enum', constraints: 'pending/completed/cancelled' }],
    })
  })

  it('rejects quality attributes without a measurable target', () => {
    expect(() =>
      validate(specOf({ quality: parsed({ quality_attributes: [quality()] }).quality })),
    ).not.toThrow()
    const unmeasurable = parsed({
      quality_attributes: [quality({ target: '尽快完成' })],
    }).quality
    expect(() => validate(specOf({ quality: unmeasurable }))).toThrow('目标必须可度量')
  })

  it('rejects quality attributes with unknown kinds or missing mapping', () => {
    expect(() => parsed({ quality_attributes: [quality({ kind: 'speed' })] })).toThrow(
      'kind 必须是 performance',
    )
    const unmapped = parsed({
      quality_attributes: [quality({ point_ids: [], acceptance_ids: [] })],
    })
    expect(() => validate(specOf({ quality: unmapped.quality }))).toThrow('必须至少关联')
  })

  it('requires a retention policy for personal data and a field list', () => {
    expect(() =>
      parsed({ data_requirements: [dataRequirement({ pii: true, retention: '' })] }),
    ).toThrow('标记为个人信息时必须给出保留期')
    expect(() => parsed({ data_requirements: [dataRequirement({ fields: [] })] })).toThrow(
      '必须给出至少一个字段',
    )
    expect(() => parsed({ data_requirements: [dataRequirement({ pii: true })] })).not.toThrow()
  })

  it('rejects malformed data requirements assembled without the parser', () => {
    const base = {
      id: 'DATA-1',
      entity: '订单',
      retention: '',
      pii: false,
      pointIds: ['BP-1'],
      acceptanceIds: [],
    }
    expect(() => validate(specOf({ data: [{ ...base, fields: [] }] }))).toThrow(
      '必须给出至少一个字段',
    )
    expect(() =>
      validate(specOf({ data: [{ ...base, fields: [{ name: '', type: '', constraints: '' }] }] })),
    ).toThrow('字段必须有名称与类型')
    expect(() =>
      validate(
        specOf({
          data: [
            {
              ...base,
              pii: true,
              fields: [{ name: 'phone', type: 'string', constraints: '' }],
            },
          ],
        }),
      ),
    ).toThrow('标记为个人信息时必须给出保留期')
  })

  it('rejects quality and data artifacts on a problem input', () => {
    expect(() =>
      validateSpec({
        spec: specOf({ quality: parsed({ quality_attributes: [quality()] }).quality }),
        complete: true,
        inputKind: 'problem',
      }),
    ).toThrow('问题输入不做业务要点拆解')
  })

  it('reports missing quality attributes and data requirements only when the requirement mentions them', () => {
    const plain = requirementStageGaps(specOf(), ['订单页按状态筛选'])
    expect(plain.map((gap) => gap.code)).toEqual(['samples', 'sample_coverage'])

    const hinted = requirementStageGaps(specOf(), ['订单页按状态筛选，首屏响应时间不超过 2 秒'])
    expect(hinted.map((gap) => gap.code)).toContain('quality_attributes')

    const dataHinted = requirementStageGaps(specOf(), ['订单导出包含手机号，需要保留 1 年'])
    expect(dataHinted.map((gap) => gap.code)).toContain('data_requirements')

    const complete = requirementStageGaps(
      specOf({
        quality: parsed({ quality_attributes: [quality()] }).quality,
        data: parsed({ data_requirements: [dataRequirement()] }).data,
      }),
      ['首屏响应时间不超过 2 秒，导出包含手机号，需要保留 1 年'],
    )
    expect(complete.map((gap) => gap.code)).not.toContain('quality_attributes')
    expect(complete.map((gap) => gap.code)).not.toContain('data_requirements')
  })

  it('keeps quality attributes and data requirements across record and read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-engineering-spec-'))
    const database = Database.open(join(dir, 'records.sqlite'))
    const repository = new Repository(database)
    try {
      repository.submit({
        reqId: 'req-1',
        project: 'forgeloop',
        text: '订单页按状态筛选',
        submittedBy: 'owner',
        source: 'test',
        clientKey: '',
        now: '2026-11-20T00:00:00.000Z',
      })
      const fields = parsed({
        quality_attributes: [quality()],
        data_requirements: [dataRequirement()],
      })
      repository.recordAnalysis(
        {
          reqId: 'req-1',
          analysisVersion: 1,
          requirementVersion: 1,
          inputKind: 'requirement',
          goal: '订单筛选',
          scenarios: [],
          businessRules: [],
          exceptions: [],
          nonGoals: [],
          acceptanceCriteria: ['列表只显示已完成的订单'],
          businessPoints: fields.points,
          acceptanceItems: fields.acceptance,
          assumptions: [],
          conflicts: [],
          references: [],
          uiMap: [],
          samples: [],
          quality: fields.quality,
          data: fields.data,
          clarifications: [],
          model: 'test',
          promptVersion: 'analysis-v7',
          transcriptPath: '',
          toolCalls: [],
          createdAt: '2026-11-20T00:00:00.000Z',
        },
        { questions: [], updates: [] },
      )
      const latest = repository.latestAnalysis('req-1')
      expect(latest?.quality?.[0]?.id).toBe('QA-1')
      expect(latest?.quality?.[0]?.target).toBe('P95 ≤ 2 秒')
      expect(latest?.data?.[0]?.entity).toBe('订单')
      expect(latest?.data?.[0]?.fields?.[0]?.name).toBe('status')
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
