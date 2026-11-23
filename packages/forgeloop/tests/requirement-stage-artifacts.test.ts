import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import {
  analysisSpecOf,
  parseSpecFields,
  requirementStageGaps,
  validateSpec,
  type AnalysisSpec,
} from '../src/domain/spec.js'

const point = (overrides: Record<string, unknown> = {}) => ({
  id: 'BP-1',
  basis: 'user_requirement',
  source: '用户原文：门店按状态处理订单',
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

const reference = (overrides: Record<string, unknown> = {}) => ({
  id: 'REF-1',
  kind: 'project_doc',
  locator: 'docs/order.md#状态',
  version: '2026-11-20',
  excerpt: '订单只有待确认、已完成、已取消三种状态',
  point_ids: ['BP-1'],
  acceptance_ids: [],
  ...overrides,
})

const uiEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'UI-1',
  entry: '天工 → 工作台 → 按需求',
  path: '选择需求后打开概览',
  feedback: '概览列出三种订单状态',
  states: ['无订单', '读取失败'],
  point_ids: ['BP-1'],
  acceptance_ids: ['AC-1'],
  prototype_ref: '',
  prototype_version: '',
  ...overrides,
})

const sample = (overrides: Record<string, unknown> = {}) => ({
  id: 'SMP-1',
  kind: 'normal',
  acceptance_ids: ['AC-1'],
  data: '待确认 1 单、已完成 2 单、已取消 1 单',
  precondition: '已登录店长账号',
  steps: ['打开订单列表', '选择“已完成”'],
  expected: '只显示 2 条已完成订单',
  observe_at: '订单列表行数',
  ...overrides,
})

function parsed(overrides: Record<string, unknown> = {}) {
  return parseSpecFields({
    business_points: [point()],
    acceptance_criteria: [acceptance()],
    ...overrides,
  })
}

function specOf(overrides: Partial<AnalysisSpec> = {}): AnalysisSpec {
  return {
    points: parsed().points,
    acceptance: parsed().acceptance,
    assumptions: [],
    conflicts: [],
    references: [],
    uiMap: [],
    samples: [],
    ...overrides,
  }
}

function validate(
  spec: AnalysisSpec,
  input: { inputKind?: 'requirement' | 'problem'; complete?: boolean; docs?: string[] } = {},
) {
  validateSpec({
    spec,
    complete: input.complete ?? true,
    inputKind: input.inputKind ?? 'requirement',
    requirementTexts: ['门店按状态处理订单'],
    projectDocExists: (relative) => (input.docs ?? ['docs/order.md']).includes(relative),
  })
}

describe('requirement stage artifacts', () => {
  it('parses references, ui map and samples into stable camel case fields', () => {
    const fields = parsed({
      references: [reference()],
      ui_map: [uiEntry()],
      samples: [sample()],
    })
    expect(fields.references).toEqual([
      {
        id: 'REF-1',
        kind: 'project_doc',
        locator: 'docs/order.md#状态',
        version: '2026-11-20',
        excerpt: '订单只有待确认、已完成、已取消三种状态',
        pointIds: ['BP-1'],
        acceptanceIds: [],
      },
    ])
    expect(fields.uiMap[0]).toMatchObject({
      id: 'UI-1',
      pointIds: ['BP-1'],
      states: ['无订单', '读取失败'],
    })
    expect(fields.samples[0]).toMatchObject({
      id: 'SMP-1',
      kind: 'normal',
      acceptanceIds: ['AC-1'],
      steps: ['打开订单列表', '选择“已完成”'],
      observeAt: '订单列表行数',
    })
  })

  it('rejects unknown reference kinds, empty excerpts and unpaired prototype versions', () => {
    expect(() => parsed({ references: [reference({ kind: 'article' })] })).toThrow(
      'kind 必须是 project_doc',
    )
    expect(() => parsed({ references: [reference({ excerpt: ' ' })] })).toThrow(
      'excerpt 必须是非空字符串',
    )
    expect(() =>
      parsed({ ui_map: [uiEntry({ prototype_ref: '', prototype_version: 'v2' })] }),
    ).toThrow('必须同时给出原型引用')
  })

  it('rejects samples without steps or acceptance mapping', () => {
    expect(() => parsed({ samples: [sample({ steps: [] })] })).toThrow('必须给出至少一步操作')
    expect(() =>
      validate(specOf({ samples: parsed({ samples: [sample({ acceptance_ids: [] })] }).samples })),
    ).toThrow('必须关联至少一个验收项')
  })

  it('requires an excerpted reference for convention and external points', () => {
    const convention = specOf({
      points: parsed({
        business_points: [point({ basis: 'project_convention', source: 'docs/order.md#状态' })],
      }).points,
    })
    expect(() => validate(convention)).toThrow('必须在 references 中给出可回查的摘录')

    validate(
      specOf({
        points: convention.points,
        references: parsed({ references: [reference()] }).references,
      }),
    )
  })

  it('rejects artifact mappings that point at unknown ids', () => {
    expect(() =>
      validate(
        specOf({
          points: parsed({
            business_points: [point({ basis: 'project_convention', source: 'docs/order.md' })],
          }).points,
          references: parsed({ references: [reference({ point_ids: ['BP-9'] })] }).references,
        }),
      ),
    ).toThrow('关联了不存在的业务要点 BP-9')

    expect(() =>
      validate(
        specOf({ samples: parsed({ samples: [sample({ acceptance_ids: ['AC-9'] })] }).samples }),
      ),
    ).toThrow('关联了不存在的验收项 AC-9')

    expect(() =>
      validate(
        specOf({
          uiMap: parsed({ ui_map: [uiEntry({ point_ids: [], acceptance_ids: [] })] }).uiMap,
        }),
      ),
    ).toThrow('必须至少关联一个业务要点或验收项')
  })

  it('rejects a project document reference that does not exist', () => {
    expect(() =>
      validate(
        specOf({
          points: parsed({
            business_points: [point({ basis: 'project_convention', source: 'docs/order.md' })],
          }).points,
          references: parsed({ references: [reference({ locator: 'docs/missing.md' })] })
            .references,
        }),
        { docs: ['docs/order.md'] },
      ),
    ).toThrow('引用的项目文档不存在或不可读')
  })

  it('rejects requirement artifacts on a problem input', () => {
    expect(() =>
      validateSpec({
        spec: specOf({ samples: parsed({ samples: [sample()] }).samples }),
        complete: true,
        inputKind: 'problem',
      }),
    ).toThrow('问题输入不做业务要点拆解')
  })

  it('reports missing samples, counter-example and references as stage gaps', () => {
    const gaps = requirementStageGaps(
      specOf({
        uiMap: parsed({ ui_map: [uiEntry()] }).uiMap,
        points: parsed({
          business_points: [point({ basis: 'project_convention', source: 'docs/order.md' })],
        }).points,
      }),
    )
    expect(gaps.map((gap) => gap.code).sort()).toEqual(['counter_example', 'references', 'samples'])

    expect(
      requirementStageGaps(
        specOf({
          samples: parsed({ samples: [sample({ kind: 'counter_example' })] }).samples,
        }),
      ),
    ).toEqual([])
  })

  it('keeps references, ui map and samples across record and read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-stage-artifacts-'))
    const database = Database.open(join(dir, 'records.sqlite'))
    const repository = new Repository(database)
    try {
      repository.submit({
        reqId: 'req-1',
        project: 'forgeloop',
        text: '门店按状态处理订单',
        submittedBy: 'owner',
        source: 'test',
        clientKey: '',
        now: '2026-11-20T00:00:00.000Z',
      })
      const fields = parsed({
        references: [reference()],
        ui_map: [uiEntry()],
        samples: [sample()],
      })
      repository.recordAnalysis({
        reqId: 'req-1',
        analysisVersion: 1,
        requirementVersion: 1,
        goal: '门店按状态处理订单',
        scenarios: ['店长筛选订单'],
        acceptanceCriteria: ['列表只显示已完成的订单'],
        businessPoints: fields.points,
        acceptanceItems: fields.acceptance,
        references: fields.references,
        uiMap: fields.uiMap,
        samples: fields.samples,
        clarifications: [],
        createdAt: '2026-11-20T00:00:00.000Z',
      })

      const stored = repository.analyses('req-1')[0]!
      expect(stored.references).toEqual(fields.references)
      expect(stored.uiMap).toEqual(fields.uiMap)
      expect(stored.samples).toEqual(fields.samples)
      expect(analysisSpecOf(stored).samples).toHaveLength(1)
    } finally {
      repository.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
