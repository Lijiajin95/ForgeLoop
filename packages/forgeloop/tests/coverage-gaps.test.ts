import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIntake } from '../src/session/intake.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig, type ForgeLoopConfig, type DeploymentTargetConfig } from '../src/config.js'
import { parseSpecFields, renderAcceptanceCriterion, validateSpec } from '../src/domain/spec.js'
import { acquireHostLock } from '../src/runtime/lock.js'
import { candidateDeploymentGate } from '../src/runtime/deployment-gate.js'
import { asRecord } from '../src/domain/json.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-coverage-gaps-'))
  roots.push(dir)
  return dir
}

const fakeRunner: AgentLike = {
  async run(request) {
    return {
      status: 'completed',
      text: '',
      sessionId: 'coverage-gaps',
      reason: '',
      transcriptPath: request.transcriptPath,
      durationMs: 1,
      toolCalls: [],
    }
  },
}

function tmpdirRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-gate-'))
  roots.push(dir)
  return dir
}

function runtimeWith(dir: string) {
  const runtime = new ForgeLoopRuntime({
    ctx: {},
    config: resolveConfig(
      {
        project: 'demo',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      },
      dir,
    ),
    runner: fakeRunner,
    now: () => new Date('2026-11-16T10:00:00.000Z'),
  })
  return { runtime }
}

function submit(runtime: ForgeLoopRuntime, text: string): string {
  const result = runtime.submit({ text, by: 'owner', source: 'test', analyze: false })
  const reqId = asRecord(result.data)?.reqId
  if (typeof reqId !== 'string') throw new Error('测试需求没有身份')
  return reqId
}

class FakeSession {
  readonly id = 'session-gaps'
  readonly header: Record<string, unknown> = { agentPreset: 'forgeloop' }
  readonly events: Array<{ type: string; data: Record<string, unknown> }> = []
  readonly append = vi.fn((type: string, data: Record<string, unknown>) => {
    this.events.push({ type, data })
  })
}

function human(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

const analysis = {
  analysisVersion: 1,
  requirementVersion: 1,
  inputKind: 'requirement' as const,
  goal: '目标',
  scenarios: ['场景'],
  businessRules: [],
  exceptions: [],
  nonGoals: [],
  acceptanceCriteria: ['验收'],
  clarifications: [],
  model: 'fake',
  promptVersion: 'v',
  toolCalls: [],
}

function pending(reqId: string, questionIds: string[], questions: string[]) {
  return {
    reqId,
    title: '标题',
    requirementVersion: 1,
    analysisVersion: 1,
    questionIds,
    questions,
    updatedAt: '2026-11-16T10:00:00.000Z',
  }
}

function intakeWith(overrides: Record<string, unknown> = {}) {
  const runtime = {
    pendingClarifications: () => [],
    openClarifications: () => [],
    submit: () => ({ ok: true, code: 'ok', message: '已受理', data: { reqId: 'req-new' } }),
    analyzeRequirement: async () => ({
      ok: true,
      code: 'ok',
      message: 'ok',
      analysis,
      requirementVersion: 1,
    }),
    answerClarifications: async () => ({
      ok: true,
      code: 'ok',
      message: 'ok',
      analysis,
      requirementVersion: 2,
      answeredQuestionIds: ['Q1-1'],
    }),
    analysisQueue: { enqueue: () => ({ ok: true, code: 'ok', message: '' }) },
    ...overrides,
  }
  const config = { owner: 'owner' } as ForgeLoopConfig
  const intake = new SessionIntake({ runtime: runtime as unknown as ForgeLoopRuntime, config })
  return { runtime, config, intake }
}

async function send(
  intake: SessionIntake,
  session: FakeSession,
  text: string,
  messageId = 'msg-1',
) {
  const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  await intake.handlePreStep(
    { agent: { session }, messages: [human(messageId, text)], turn: 1 },
    next,
  )
}

describe('session intake directive errors', () => {
  it('reports an empty explicit new-requirement entry', async () => {
    const { intake } = intakeWith()
    const session = new FakeSession()
    await send(intake, session, '新需求：   ')
    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/error'])
    expect(String(session.events[0]!.data.message)).toContain('新需求入口后没有内容')
  })

  it('asks for an explicit target when several requirements await answers', async () => {
    const { intake } = intakeWith({
      pendingClarifications: () => [
        pending('req-1', ['Q1-1'], ['问题一']),
        pending('req-2', ['Q2-1'], ['问题二']),
      ],
    })
    const session = new FakeSession()
    await send(intake, session, '我的回答')
    expect(String(session.events[0]!.data.message)).toContain('回答 <需求编号>')
  })

  it('rejects answers for unknown or non-pending requirements with the open list', async () => {
    const { intake } = intakeWith()
    const noPending = new FakeSession()
    await send(intake, noPending, '回答 req-1：答复')
    expect(String(noPending.events[0]!.data.message)).toContain('没有待澄清项')

    const other = intakeWith({
      pendingClarifications: () => [pending('req-1', ['Q1-1'], ['问题一'])],
    })
    const withPending = new FakeSession()
    await send(other.intake, withPending, '回答 req-9：答复')
    expect(String(withPending.events[0]!.data.message)).toContain('不在本会话待澄清列表')
  })

  it('rejects an empty answer body and unknown question ids', async () => {
    const { intake } = intakeWith({
      pendingClarifications: () => [pending('req-1', ['Q1-1'], ['问题一'])],
    })
    const empty = new FakeSession()
    await send(intake, empty, '回答 req-1：', 'msg-empty')
    expect(String(empty.events[0]!.data.message)).toContain('澄清回答入口后没有内容')

    const wrongQuestion = new FakeSession()
    await send(intake, wrongQuestion, '回答 req-1 [Q9-9]：答复', 'msg-wrong-question')
    expect(String(wrongQuestion.events[0]!.data.message)).toContain('不是当前开放问题')
  })

  it('reports a rejected submission without creating a requirement', async () => {
    const { intake } = intakeWith({
      submit: () => ({ ok: false, code: 'refused', message: '来源不被信任' }),
    })
    const session = new FakeSession()
    await send(intake, session, '新需求：给我一个页面')
    expect(String(session.events[0]!.data.message)).toBe('来源不被信任')
  })

  it('routes a valid answer to the runtime and renders the answer event', async () => {
    const answered: unknown[] = []
    const { intake } = intakeWith({
      pendingClarifications: () => [pending('req-1', ['Q1-1'], ['问题一'])],
      answerClarifications: async (input: unknown) => {
        answered.push(input)
        return {
          ok: true,
          code: 'ok',
          message: 'ok',
          analysis,
          requirementVersion: 2,
          answeredQuestionIds: ['Q1-1'],
        }
      },
    })
    const session = new FakeSession()
    await send(intake, session, '回答 req-1：按方案 A 处理')
    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/clarification-answer',
      'plugin:forgeloop/analysis',
    ])
    expect(asRecord(answered[0])?.answer).toBe('按方案 A 处理')
  })
})

describe('analysis spec validation gaps', () => {
  const point = {
    id: 'BP-1',
    basis: 'user_requirement',
    source: '需求原文',
    actor: '用户',
    trigger: '打开时',
    behavior: '看到列表',
    rules: [],
    exceptions: { status: 'not_applicable', items: [], reason: '无异常' },
  }

  it('rejects malformed business points and exception states', () => {
    expect(() => parseSpecFields({ business_points: {} })).toThrow('business_points 必须是数组')
    expect(() => parseSpecFields({ business_points: [{ ...point, id: ' ' }] })).toThrow(
      '必须是非空字符串',
    )
    expect(() => parseSpecFields({ business_points: [{ ...point, basis: 'inference' }] })).toThrow(
      '.basis 必须是 user_requirement',
    )
    expect(() =>
      parseSpecFields({ business_points: [{ ...point, exceptions: { status: 'weird' } }] }),
    ).toThrow('.status 必须是 assessed')
    expect(() =>
      parseSpecFields({
        business_points: [{ ...point, exceptions: { status: 'assessed', items: [], reason: '' } }],
      }),
    ).toThrow('标记已评估时必须列出异常与边界')
    expect(() =>
      parseSpecFields({
        business_points: [
          { ...point, exceptions: { status: 'unanalyzed', items: ['x'], reason: 'r' } },
        ],
      }),
    ).toThrow('不是 assessed 时 items 必须为空')
    expect(() =>
      parseSpecFields({
        business_points: [{ ...point, exceptions: { status: 'unanalyzed', items: [] } }],
      }),
    ).toThrow('必须说明理由')
  })

  it('rejects malformed acceptance criteria and assumptions', () => {
    expect(() => parseSpecFields({ acceptance_criteria: 'x' })).toThrow('必须是数组')
    expect(() =>
      parseSpecFields({ business_points: [point], acceptance_criteria: ['纯文本验收'] }),
    ).toThrow('必须使用带编号的对象')
    expect(() => parseSpecFields({ acceptance_criteria: [''] })).toThrow('只能包含非空字符串')
    expect(() =>
      parseSpecFields({
        acceptance_criteria: [
          '纯文本',
          { id: 'AC-1', point_ids: ['BP-1'], given: 'g', when: 'w', then: 't' },
        ],
      }),
    ).toThrow('不能混用字符串与对象')
    expect(() => parseSpecFields({ assumptions: {} })).toThrow('assumptions 必须是数组')
    expect(() =>
      parseSpecFields({
        assumptions: [
          {
            id: 'AS-1',
            statement: 's',
            basis: 'user_requirement',
            source: 'x',
            impact: 'i',
            needs_confirmation: true,
          },
        ],
      }),
    ).toThrow('basis 必须是 inference')
    expect(() =>
      parseSpecFields({
        assumptions: [
          {
            id: 'AS-1',
            statement: 's',
            basis: 'inference',
            source: 'x',
            impact: 'i',
          },
        ],
      }),
    ).toThrow('needs_confirmation 必须是布尔值')
  })

  it('keeps historical string acceptance and rejects mixed objects from older rows', () => {
    const parsed = parseSpecFields({ acceptance_criteria: ['可观察结果'] })
    expect(parsed.acceptanceCriteria).toEqual(['可观察结果'])
    expect(parsed.acceptance).toEqual([])
    expect(parseSpecFields({}).acceptanceCriteria).toEqual([])
  })

  it('rejects reused retired ids and reordered history ids', () => {
    const acceptance = [{ id: 'AC-1', pointIds: ['BP-2'], given: 'g', when: 'w', then: 't' }]
    const spec = {
      points: [{ ...point, id: 'BP-2' }],
      acceptance,
      assumptions: [],
      conflicts: [],
      acceptanceCriteria: ['t'],
    }
    const previous = { ...spec }
    const base = {
      spec,
      complete: true,
      inputKind: 'requirement' as const,
      requirementTexts: ['需求原文'],
    }
    expect(() => validateSpec({ ...base, previous })).not.toThrow()
    expect(() =>
      validateSpec({
        ...base,
        spec: {
          ...spec,
          points: [{ ...point, id: 'BP-1' }],
          acceptance: [{ ...acceptance[0]!, pointIds: ['BP-1'] }],
        },
        previous,
      }),
    ).toThrow('必须大于既有最大编号')
    expect(() =>
      validateSpec({
        ...base,
        spec: {
          ...spec,
          points: [{ ...point, id: 'BP-1' }],
          acceptance: [{ ...acceptance[0]!, pointIds: ['BP-1'] }],
        },
        previous: null,
        historicalIds: ['BP-1'],
      }),
    ).toThrow('退役后不能复用')
  })
})

describe('analysis spec reference and completion rules', () => {
  const point = {
    id: 'BP-1',
    basis: 'user_requirement' as const,
    source: '需求原文：打开页面看到列表',
    actor: '用户',
    trigger: '打开页面',
    behavior: '看到列表',
    rules: [],
    exceptions: { status: 'assessed' as const, items: ['无网络时提示'], reason: '' },
  }
  const acceptance = [{ id: 'AC-1', pointIds: ['BP-1'], given: 'g', when: 'w', then: 't' }]

  it('renders acceptance criteria and parses a comparable conflict', () => {
    expect(
      renderAcceptanceCriterion({
        id: 'AC-1',
        pointIds: ['BP-1'],
        given: 'g',
        when: 'w',
        then: 't',
      }),
    ).toBe('AC-1：给定 g；当 w；则 t')

    const parsed = parseSpecFields({
      conflicts: [
        {
          existing_req_id: 'req-1',
          commitment: '旧承诺',
          conflict: '新需求冲突',
          options: ['保留旧承诺', '推迟新需求'],
          decision_needed: '选哪个',
        },
      ],
    })
    expect(parsed.conflicts).toEqual([
      {
        existingReqId: 'req-1',
        commitment: '旧承诺',
        conflict: '新需求冲突',
        options: ['保留旧承诺', '推迟新需求'],
        decisionNeeded: '选哪个',
      },
    ])
    expect(() => parseSpecFields({ conflicts: {} })).toThrow('conflicts 必须是数组')
    expect(() => parseSpecFields({ conflicts: [{}] })).toThrow('至少两种可比较的取舍')
    expect(() => parseSpecFields({ business_points: ['x'] })).toThrow('必须是对象')
    expect(() => parseSpecFields({ acceptance_criteria: [42] })).toThrow('必须是对象')
  })

  it('requires evidence for points and rejects empty or dangling references', () => {
    const base = {
      points: [point],
      acceptance,
      assumptions: [],
      conflicts: [],
      acceptanceCriteria: ['t'],
    }
    const complete = { complete: true, inputKind: 'requirement' as const }

    expect(() =>
      validateSpec({
        ...complete,
        spec: { ...base, points: [{ ...point, source: '需求里没有这句话' }] },
        requirementTexts: ['需求原文：打开页面看到列表'],
      }),
    ).toThrow('用户原文依据无法在需求版本中逐字核对')

    expect(() =>
      validateSpec({
        ...complete,
        spec: { ...base, points: [{ ...point, basis: 'project_convention', source: 'docs/a.md' }] },
        projectDocExists: () => false,
      }),
    ).toThrow('引用的项目约定文档不存在或不可读')

    expect(() =>
      validateSpec({
        ...complete,
        spec: {
          ...base,
          points: [{ ...point, basis: 'external_material', source: 'ftp://example.com' }],
        },
      }),
    ).toThrow('外部资料必须是 http(s) 地址')

    expect(() =>
      validateSpec({
        ...complete,
        spec: {
          ...base,
          points: [{ ...point, basis: 'project_convention', source: 'docs/a.txt' }],
          acceptance: [{ ...acceptance[0]!, pointIds: ['BP-1'] }],
        },
        projectDocExists: () => true,
      }),
    ).toThrow('引用项目约定时必须给出项目文档路径')

    expect(() =>
      validateSpec({
        ...complete,
        spec: { ...base, acceptance: [{ ...acceptance[0]!, pointIds: [] }] },
      }),
    ).toThrow('必须引用至少一个业务要点')

    expect(() =>
      validateSpec({
        ...complete,
        spec: { ...base, acceptance: [{ ...acceptance[0]!, pointIds: ['BP-9'] }] },
      }),
    ).toThrow('引用了不存在的业务要点')

    expect(() =>
      validateSpec({ ...complete, spec: { ...base, acceptance: [], points: [] } }),
    ).toThrow('没有待澄清项时必须给出业务要点')

    // 项目约定依据必须能定位到真实存在的 Markdown 文档；两条正向路径都要可用。
    expect(() =>
      validateSpec({
        ...complete,
        spec: {
          ...base,
          points: [{ ...point, basis: 'project_convention', source: 'docs/a.md#章节' }],
        },
        projectDocExists: () => true,
      }),
    ).not.toThrow()
    expect(() =>
      validateSpec({
        ...complete,
        spec: {
          ...base,
          points: [{ ...point, basis: 'external_material', source: 'https://example.com/a' }],
        },
      }),
    ).not.toThrow()
  })

  it('accepts problem input only without structured spec and validates conflicts', () => {
    const empty = {
      points: [],
      acceptance: [],
      assumptions: [],
      conflicts: [],
      acceptanceCriteria: [],
    }
    expect(() => validateSpec({ spec: empty, complete: false, inputKind: 'problem' })).not.toThrow()
    expect(() =>
      validateSpec({
        spec: { ...empty, points: [point] },
        complete: false,
        inputKind: 'problem',
      }),
    ).toThrow('问题输入不做业务要点拆解')

    const conflict = {
      existingReqId: 'req-other',
      commitment: '旧承诺',
      conflict: '冲突',
      options: [
        { summary: 'a', effect: 'e', cost: 'c', risk: 'r' },
        { summary: 'b', effect: 'e', cost: 'c', risk: 'r' },
      ],
      decisionNeeded: '选哪个',
    }
    expect(() =>
      validateSpec({
        spec: { ...empty, conflicts: [conflict] },
        complete: false,
        inputKind: 'requirement',
        knownRequirementIds: ['req-other'],
        currentReqId: 'req-self',
      }),
    ).not.toThrow()
    expect(() =>
      validateSpec({
        spec: { ...empty, conflicts: [conflict] },
        complete: false,
        inputKind: 'requirement',
        knownRequirementIds: [],
        currentReqId: 'req-self',
      }),
    ).toThrow('不是项目中已存在的其他需求')
    expect(() =>
      validateSpec({
        spec: { ...empty, conflicts: [conflict] },
        complete: false,
        inputKind: 'requirement',
        knownRequirementIds: ['req-other'],
        currentReqId: 'req-other',
      }),
    ).toThrow('不是项目中已存在的其他需求')
  })
})

describe('deployment gate acceptance evidence', () => {
  it('refuses an owner target whose acceptance material cannot be verified', () => {
    const root = tmpdirRoot()
    const { runtime } = runtimeWith(root)
    const reqId = submit(runtime, '需求')
    // 候选材料齐全（提交、测试、业务验收、构建），只剩验收指纹不可复核。
    runtime.repo.recordCommit({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'c'.repeat(64),
      commitSha: 'a'.repeat(40),
      commitMessage: '',
      checkCommand: [],
      checkLogPath: '/gate.log',
      checkSha256: 'g'.repeat(64),
      files: [],
      committedAt: '2026-11-16T09:50:00.000Z',
    })
    runtime.repo.recordVerification({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'c'.repeat(64),
      requirementVersion: 1,
      workspaceSha256: '',
      verdict: 'pass',
      reportJson: '{}',
      reportPath: '/v.json',
      reportSha256: 'v'.repeat(64),
      evidenceDir: '/v',
      sessionId: 's',
      verifiedAt: '2026-11-16T09:51:00.000Z',
    })
    runtime.repo.recordBusinessReview({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'c'.repeat(64),
      requirementVersion: 1,
      verificationSha256: 'v'.repeat(64),
      verdict: 'pass',
      reportJson: '{}',
      reportPath: '/r.json',
      reportSha256: 'r'.repeat(64),
      sessionId: 's',
      reviewedAt: '2026-11-16T09:52:00.000Z',
    })
    runtime.repo.recordCandidateBuild({
      reqId,
      planVersion: 1,
      candidateSha256: 'c'.repeat(64),
      verificationSha256: 'v'.repeat(64),
      packageVersion: '0.0.2',
      artifactSha256: 'p'.repeat(64),
      tarball: '/artifact.tgz',
      files: [],
      gitHead: 'a'.repeat(40),
      builtAt: '2026-11-16T09:53:00.000Z',
      evidenceDir: '/b',
    })
    runtime.repo.setStatus(reqId, 'committed', '')
    runtime.repo.recordAcceptance({
      reqId,
      acceptedBy: 'owner',
      source: 'web-decision',
      fingerprint: 'stale',
      now: '2026-11-16T10:00:00.000Z',
    })
    const gate = candidateDeploymentGate(runtime.repo)
    const target = {
      id: 'target',
      toolId: 'tool',
      requirementId: '',
      params: {},
      data: { volumes: [], migrations: [] },
      approval: 'owner',
      autoDeliver: false,
      rollback: { keep: 1 },
    } as unknown as DeploymentTargetConfig
    const artifact = { sha256: 'p'.repeat(64), path: '/artifact.tgz', version: '0.0.2' }
    expect(gate(target, artifact, reqId)).toMatchObject({
      ok: false,
      reason: '无法复核验收所绑定的候选材料，不能继续部署',
    })
    expect(gate(target, artifact, '')).toMatchObject({
      ok: false,
      reason: '需求不存在或未指定所属需求，不能继续部署',
    })
    runtime.close()
  })
})

describe('configuration validation gaps', () => {
  const cwdFor = (dir: string) => join(dir, 'project')

  function configWith(dir: string, raw: Record<string, unknown>) {
    return resolveConfig(raw, cwdFor(dir))
  }

  it('rejects an empty trusted source list and invalid retention numbers', () => {
    const dir = root()
    expect(() => configWith(dir, { autonomy: { trustedSources: [] } })).toThrow(
      'autonomy.trustedSources 不能为空',
    )
    expect(() => configWith(dir, { deployments: { retention: { days: 0 } } })).toThrow(
      'deployments.retention.days 必须是正整数',
    )
    expect(() => configWith(dir, { deployments: { retention: { days: 4000 } } })).toThrow(
      '不能大于 3650 天',
    )
    expect(() =>
      configWith(dir, { deployments: { retention: { days: 10, compressEveryDays: 20 } } }),
    ).toThrow('不能大于 days')
    expect(() => configWith(dir, { deployments: { retention: { maxBytes: 1024 } } })).toThrow(
      '不能小于 1 MiB',
    )
  })

  it('rejects malformed deployment tool and target declarations', () => {
    const dir = root()
    const projectDir = cwdFor(dir)
    // 部署目录固定在 <recordsRoot>/projects/<project>/deployments，toolRoot 默认其下 tools/。
    const deploymentRoot = join(projectDir, '.forgeloop', 'projects', 'forgeloop', 'deployments')
    const toolRoot = join(deploymentRoot, 'tools')
    mkdirSync(toolRoot, { recursive: true })
    const script = join(toolRoot, 'deploy.sh')
    writeFileSync(script, '#!/bin/sh\n', 'utf8')
    const outside = join(deploymentRoot, 'outside.sh')
    writeFileSync(outside, '#!/bin/sh\n', 'utf8')
    const tool = {
      id: 'tool',
      kind: 'shell',
      path: script,
      capabilities: ['preflight', 'apply'],
      timeoutSeconds: 10,
    }
    const target = {
      id: 'target',
      toolId: 'tool',
      requirementId: '',
      params: {},
      data: { volumes: [], migrations: [] },
      approval: 'owner',
      autoDeliver: false,
      rollback: { keep: 1 },
    }

    expect(() => configWith(dir, { deployments: { toolRoot: 'tools', tools: ['x'] } })).toThrow(
      '必须是对象',
    )
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [
            { ...tool, id: 'a' },
            { ...tool, id: 'a' },
          ],
        },
      }),
    ).toThrow('.id 重复')
    expect(() =>
      configWith(dir, { deployments: { toolRoot: 'tools', tools: [{ ...tool, kind: 'docker' }] } }),
    ).toThrow('.kind 只能是')
    expect(() =>
      configWith(dir, {
        deployments: { toolRoot: 'tools', tools: [{ ...tool, path: 'relative.sh' }] },
      }),
    ).toThrow('必须是绝对路径')
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [{ ...tool, path: join(toolRoot, 'missing.sh') }],
        },
      }),
    ).toThrow('指向的脚本不存在')
    expect(() =>
      configWith(dir, { deployments: { toolRoot: 'tools', tools: [{ ...tool, path: outside }] } }),
    ).toThrow('必须位于 deployments.toolRoot 内')
    expect(() =>
      configWith(dir, {
        deployments: { toolRoot: 'tools', tools: [{ ...tool, capabilities: [] }] },
      }),
    ).toThrow('至少要声明')
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [{ ...tool, capabilities: ['preflight', 'teleport'] }],
        },
      }),
    ).toThrow('能力')
    expect(() => configWith(dir, { deployments: { alerts: { webhook: 42 } } })).toThrow(
      'webhook 必须是字符串',
    )
    expect(() => configWith(dir, { deployments: { alerts: { webhook: 'not-a-url' } } })).toThrow(
      'webhook 必须是合法的',
    )
    expect(() => configWith(dir, { deployments: { alerts: { timeoutSeconds: 61 } } })).toThrow(
      '不能大于 60 秒',
    )
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [tool],
          targets: [{ ...target, toolId: 'missing' }],
        },
      }),
    ).toThrow('引用了未登记的工具')
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [tool],
          targets: [{ ...target, approval: 'robot' }],
        },
      }),
    ).toThrow('approval 只能是 owner 或 auto')
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [tool],
          targets: [{ ...target, rollback: { keep: 11 } }],
        },
      }),
    ).toThrow('rollback.keep 不能大于 10')
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [tool],
          targets: [{ ...target, approval: 'auto' }],
        },
      }),
    ).toThrow('必须配置 deployments.alerts.webhook')
    const longKey = 'x'.repeat(61)
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot,
          tools: [tool],
          targets: [{ ...target, params: { [longKey]: 'v' } }],
        },
      }),
    ).toThrow('参数名必须非空且不超过 60 字符')
    expect(() =>
      configWith(dir, {
        deployments: {
          toolRoot: 'tools',
          tools: [tool],
          targets: [{ ...target, params: { key: 1 } }],
        },
      }),
    ).toThrow('必须是 1–200 字符的字符串')
  })
})

describe('host lock residue and corruption', () => {
  it('throws when the lock root cannot host a directory', () => {
    const dir = root()
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x', 'utf8')
    expect(() => acquireHostLock(file, 'owner')).toThrow()
  })

  it('cleans a corrupt owner record and a stale lock from a dead process', () => {
    const dir = root()
    mkdirSync(join(dir, 'host.lock'), { recursive: true })
    writeFileSync(join(dir, 'host.lock', 'owner.json'), 'not-json', 'utf8')
    const first = acquireHostLock(dir, 'owner')
    expect(first.acquired).toBe(true)
    first.release()
    expect(existsSync(join(dir, 'host.lock'))).toBe(false)

    mkdirSync(join(dir, 'host.lock'), { recursive: true })
    writeFileSync(
      join(dir, 'host.lock', 'owner.json'),
      JSON.stringify({ owner: 1, pid: 'x', acquiredAt: 2 }),
      'utf8',
    )
    const fallback = acquireHostLock(dir, 'owner')
    expect(fallback.acquired).toBe(true)
    fallback.release()
  })

  it('cleans a stale lock left by the same owner and keeps release idempotent', () => {
    const dir = root()
    mkdirSync(join(dir, 'host.lock'), { recursive: true })
    writeFileSync(
      join(dir, 'host.lock', 'owner.json'),
      JSON.stringify({ owner: 'owner', pid: 999999, acquiredAt: '2026-11-16T10:00:00.000Z' }),
      'utf8',
    )
    const lock = acquireHostLock(dir, 'owner')
    expect(lock.acquired).toBe(true)
    // 记录被外部删除时 release 仍按“只清理自己的现场”收口。
    rmSync(join(dir, 'host.lock', 'owner.json'), { force: true })
    lock.release()
    lock.release()
    expect(lock.acquired).toBe(true)
  })
})
