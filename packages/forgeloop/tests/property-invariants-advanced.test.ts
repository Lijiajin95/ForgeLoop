import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  parseAnalysisDraft,
  validateRequirement,
  type RequirementVersion,
} from '../src/domain/requirement.js'
import {
  executionOrder,
  parseTaskPlanDraft,
  planLimitSeconds,
  type PlannedTask,
} from '../src/domain/task-plan.js'
import { retryDecision, type RetryFacts } from '../src/domain/retry-policy.js'
import {
  DEPLOYMENT_STATES,
  canTransition,
  parseDeploymentToolResult,
} from '../src/domain/deployment.js'
import { actionArgv, opsSignatureOf, type OpsAction } from '../src/domain/ops.js'
import { candidateIdentityOf } from '../src/domain/delivery.js'
import type { TaskArtifact } from '../src/domain/work.js'
import type { BusinessReviewRecord, VerificationRecord } from '../src/records/rows.js'
import { buildAcceptanceBinding } from '../src/runtime/acceptance-binding.js'
import { propertyNumRuns, propertyOptions } from './property-support.js'

const RUNS = propertyNumRuns()
const WORD = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/)
const PATH_SEGMENT = fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/)

function versionList(count: number, text: (index: number) => string): RequirementVersion[] {
  return Array.from({ length: count }, (_item, index) => ({
    version: index + 1,
    text: text(index),
    createdAt: '2026-11-01T00:00:00.000Z',
    revisedBy: 'owner',
    source: 'property',
  }))
}

function planDraft(
  tasks: ReadonlyArray<Record<string, unknown>>,
  planVersion = 1,
): Record<string, unknown> {
  return { plan_version: planVersion, requirement_version: 1, project: 'proj', tasks }
}

function taskOf(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    task_id: 't0',
    goal: '实现能力',
    files: ['src/a.ts'],
    acceptance: '可验证',
    test_command: ['npm', 'test'],
    ...overrides,
  }
}

function plannedTask(limits: { limitSeconds: number; maxFailureRounds: number }): PlannedTask {
  return {
    taskId: 't',
    goal: 'g',
    files: ['src/a.ts'],
    acceptance: 'a',
    testCommand: ['npm', 'test'],
    dependsOn: [],
    limits,
    authorizationSource: '',
  }
}

describe('advanced property invariants', () => {
  it('keeps requirement versions contiguous and append-only', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(WORD, { minLength: 6, maxLength: 6 }),
        (count, words) => {
          const versions = versionList(count, (index) => words[index] ?? 'v')
          expect(() =>
            validateRequirement({ reqId: 'req-1', project: 'proj', versions }),
          ).not.toThrow()
          expect(versions.map((item) => item.version)).toEqual(
            Array.from({ length: count }, (_item, index) => index + 1),
          )
          // 跳号：版本号必须从 1 起连续，任何跳号都要拒绝。
          const jumped = versions.map((item, index) =>
            index === 0 ? { ...item, version: 2 } : item,
          )
          expect(() =>
            validateRequirement({ reqId: 'req-1', project: 'proj', versions: jumped }),
          ).toThrow()
          // 空原文与空身份同样拒绝，不得静默补默认值。
          expect(() =>
            validateRequirement({
              reqId: 'req-1',
              project: 'proj',
              versions: versions.map((item, index) =>
                index === 0 ? { ...item, text: '   ' } : item,
              ),
            }),
          ).toThrow()
          expect(() => validateRequirement({ reqId: '  ', project: 'proj', versions })).toThrow()
        },
      ),
      propertyOptions(RUNS),
    )
  })

  it('round-trips an analysis payload through JSON', () => {
    const draft = fc.record({
      input_kind: fc.constantFrom('requirement', 'problem'),
      goal: WORD,
      scenarios: fc.array(WORD, { minLength: 1, maxLength: 3 }),
      business_rules: fc.array(WORD, { minLength: 0, maxLength: 2 }),
      exceptions: fc.array(WORD, { minLength: 0, maxLength: 2 }),
      non_goals: fc.array(WORD, { minLength: 0, maxLength: 2 }),
      acceptance_criteria: fc.array(WORD, { minLength: 1, maxLength: 3 }),
      clarifications: fc.constant([] as string[]),
      business_context: fc.oneof(
        fc.constant({ changed: false, document: '', reason: '' }),
        fc.record({ changed: fc.constant(true), document: WORD, reason: WORD }),
      ),
    })
    fc.assert(
      fc.property(draft, (input) => {
        const parsed = parseAnalysisDraft(JSON.stringify(input))
        expect(parsed).toEqual({
          inputKind: input.input_kind,
          goal: input.goal,
          scenarios: input.scenarios,
          businessRules: input.business_rules,
          exceptions: input.exceptions,
          nonGoals: input.non_goals,
          acceptanceCriteria: input.acceptance_criteria,
          businessPoints: [],
          acceptanceItems: [],
          assumptions: [],
          clarifications: [],
          clarificationUpdates: [],
          businessContext: input.business_context,
        })
        // 问题类输入不得携带待澄清项；这是载荷边界，不是可放宽的提示。
        expect(() =>
          parseAnalysisDraft(
            JSON.stringify({ ...input, input_kind: 'problem', clarifications: ['需要澄清'] }),
          ),
        ).toThrow()
        expect(() => parseAnalysisDraft(JSON.stringify({ ...input, goal: '' }))).toThrow()
      }),
      propertyOptions(RUNS),
    )
  })

  it('keeps task plan file paths inside the project root', () => {
    const validFiles = fc
      .uniqueArray(PATH_SEGMENT, { minLength: 1, maxLength: 3 })
      .map((segments) => segments.map((segment) => `src/${segment}.ts`))
    fc.assert(
      fc.property(validFiles, (files) => {
        const draft = planDraft([
          taskOf({ files, depends_on: [] }),
          taskOf({ task_id: 't1', files: ['src/b.ts'], depends_on: ['t0'] }),
        ])
        const parsed = parseTaskPlanDraft(draft, {
          requirementId: 'req-1',
          project: 'proj',
          planVersion: 1,
          requirementVersion: 1,
          now: '2026-11-01T00:00:00.000Z',
        })
        expect(parsed.tasks[0]?.files).toEqual(files)
        // 绝对路径、越界段与重复文件都必须拒绝；连续分隔符由 split 归一化，不会越出根目录。
        for (const bad of [
          ['/abs.ts'],
          ['src/../escape.ts'],
          ['../escape.ts'],
          ['src/x.ts', 'src/x.ts'],
        ]) {
          expect(() =>
            parseTaskPlanDraft(
              planDraft([
                taskOf({ files: bad, depends_on: [] }),
                taskOf({ task_id: 't1', files: ['src/b.ts'], depends_on: ['t0'] }),
              ]),
              {
                requirementId: 'req-1',
                project: 'proj',
                planVersion: 1,
                requirementVersion: 1,
                now: '2026-11-01T00:00:00.000Z',
              },
            ),
          ).toThrow()
        }
        const normalized = parseTaskPlanDraft(
          planDraft([
            taskOf({ files: ['src//double.ts'], depends_on: [] }),
            taskOf({ task_id: 't1', files: ['src/b.ts'], depends_on: ['t0'] }),
          ]),
          {
            requirementId: 'req-1',
            project: 'proj',
            planVersion: 1,
            requirementVersion: 1,
            now: '2026-11-01T00:00:00.000Z',
          },
        )
        expect(normalized.tasks[0]?.files).toEqual(['src//double.ts'])
        for (const file of normalized.tasks[0]?.files ?? []) {
          expect(file.startsWith('/')).toBe(false)
          expect(file.split(/[\\/]+/).includes('..')).toBe(false)
        }
      }),
      propertyOptions(RUNS),
    )
  })

  it('returns a dependency-respecting execution order', () => {
    const input = fc.tuple(
      fc.integer({ min: 2, max: 6 }),
      fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 36, maxLength: 36 }),
    )
    fc.assert(
      fc.property(input, ([count, mask]) => {
        const tasks = Array.from({ length: count }, (_item, index) => ({
          taskId: `t${index}`,
          dependsOn: Array.from({ length: index }, (_unused, earlier) =>
            (mask[earlier * 6 + index] ?? 0) % 2 === 0 && earlier < index ? `t${earlier}` : '',
          )
            .filter(Boolean)
            .filter((value, position, list) => list.indexOf(value) === position),
        }))
        const order = executionOrder({ tasks: tasks.map((task) => taskOfPlan(task)) })
        expect(order).toHaveLength(count)
        expect(new Set(order)).toEqual(new Set(tasks.map((task) => task.taskId)))
        for (const task of tasks) {
          for (const dependency of task.dependsOn) {
            expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(task.taskId))
          }
        }
        // 环必须显式失败，不能返回部分顺序。
        expect(() =>
          executionOrder({
            tasks: [
              taskOfPlan({ taskId: 'a', dependsOn: ['b'] }),
              taskOfPlan({ taskId: 'b', dependsOn: ['a'] }),
            ],
          }),
        ).toThrow()
      }),
      propertyOptions(RUNS),
    )
  })

  it('aggregates plan limits as unlimited or the exact sum', () => {
    const limit = fc.oneof(fc.constant(-1), fc.integer({ min: 1, max: 1000 }))
    fc.assert(
      fc.property(fc.array(limit, { minLength: 1, maxLength: 5 }), (limits) => {
        const tasks = limits.map((value) =>
          plannedTask({ limitSeconds: value, maxFailureRounds: -1 }),
        )
        const expected = limits.some((value) => value < 0)
          ? -1
          : limits.reduce((sum, value) => sum + value, 0)
        expect(planLimitSeconds(tasks)).toBe(expected)
      }),
      propertyOptions(RUNS),
    )
  })

  it('never allows retry once failure rounds are exhausted', () => {
    const facts = fc
      .tuple(
        fc.constantFrom('approved', 'executing', 'blocked'),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 4 }),
        fc.stringMatching(/^[a-z ]{0,20}$/),
      )
      .map(([status, total, deliveredRaw, blockedReason]): RetryFacts => ({
        status,
        blockedReason,
        remainingRounds: 0,
        activeRequest: false,
        runningTasks: 0,
        awaitingInputTasks: 0,
        planApproved: true,
        delivered: Math.min(deliveredRaw, total - 1),
        total,
      }))
    fc.assert(
      fc.property(facts, (input) => {
        const decision = retryDecision(input)
        expect(decision.allowed).toBe(false)
        expect(decision.reason).toContain('额度')
      }),
      propertyOptions(RUNS),
    )
  })

  it('never allows retry from a terminal requirement state', () => {
    const facts = fc
      .tuple(
        fc.constantFrom('accepted', 'rejected', 'cancelled'),
        fc.boolean(),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
      )
      .map(([status, planApproved, delivered, total]): RetryFacts => ({
        status,
        blockedReason: '',
        remainingRounds: 3,
        activeRequest: false,
        runningTasks: 0,
        awaitingInputTasks: 0,
        planApproved,
        delivered,
        total,
      }))
    fc.assert(
      fc.property(facts, (input) => {
        const decision = retryDecision(input)
        expect(decision.allowed).toBe(false)
        expect(decision.reason).toContain('终态')
      }),
      propertyOptions(RUNS),
    )
  })

  it('never leaves a terminal deployment state', () => {
    const terminal = ['preflight_failed', 'rejected', 'rolled_back'] as const
    fc.assert(
      fc.property(
        fc.constantFrom(...terminal),
        fc.constantFrom(...DEPLOYMENT_STATES),
        (from, to) => {
          expect(canTransition(from, to)).toBe(false)
          expect(canTransition(from, to)).toBe(canTransition(from, to))
        },
      ),
      propertyOptions(RUNS),
    )
  })

  it('bounds deployment tool results and never guesses success', () => {
    const payload = fc.record({
      ok: fc.boolean(),
      state: fc.stringMatching(/^[A-Za-z_-]{1,80}$/),
      version: fc.string({ minLength: 0, maxLength: 300 }),
      detail: fc.string({ minLength: 0, maxLength: 5000 }),
      steps: fc.array(fc.string({ minLength: 0, maxLength: 500 }), { minLength: 0, maxLength: 80 }),
      restorePoint: fc.string({ minLength: 0, maxLength: 500 }),
      extra: fc.string({ minLength: 0, maxLength: 10 }),
    })
    fc.assert(
      fc.property(payload, (input) => {
        const parsed = parseDeploymentToolResult(JSON.stringify(input))
        expect(parsed.ok).toBe(input.ok)
        expect(parsed.state.length).toBeLessThanOrEqual(61)
        expect(parsed.version.length).toBeLessThanOrEqual(121)
        expect(parsed.detail.length).toBeLessThanOrEqual(2001)
        expect(parsed.steps.length).toBeLessThanOrEqual(50)
        expect(parsed.steps.every((step) => step.length <= 301)).toBe(true)
        expect(parsed.restorePoint.length).toBeLessThanOrEqual(301)
      }),
      propertyOptions(RUNS),
    )
    for (const malformed of [
      '',
      'not json',
      '[]',
      '{"state":"x"}',
      '{"ok":true}',
      '{"ok":"yes","state":"x"}',
      '{"ok":true,"state":"   "}',
    ]) {
      expect(() => parseDeploymentToolResult(malformed)).toThrow()
    }
  })

  it('keeps ops signatures stable for identical observations', () => {
    const observation = fc.record({
      resourceId: fc.constantFrom('web', 'db', 'cache'),
      checkId: fc.constantFrom('web-health', 'db-health'),
      exitCode: fc.integer({ min: 0, max: 255 }),
      output: fc.array(fc.stringMatching(/^[A-Za-z0-9 _.:-]{0,40}$/), {
        minLength: 0,
        maxLength: 4,
      }),
    })
    fc.assert(
      fc.property(observation, (input) => {
        const output = input.output.join('\n')
        const first = opsSignatureOf({ ...input, output })
        expect(opsSignatureOf({ ...input, output })).toBe(first)
        // 首行前导/尾随空白与多空格归一化后签名不变。
        expect(opsSignatureOf({ ...input, output: `  ${output}  ` })).toBe(first)
        expect(
          opsSignatureOf({
            ...input,
            resourceId: input.resourceId === 'web' ? 'db' : 'web',
            output,
          }),
        ).not.toBe(first)
      }),
      propertyOptions(RUNS),
    )
  })

  it('rejects ops action parameters outside the catalog', () => {
    const action: OpsAction = {
      id: 'restart',
      resourceId: 'web',
      command: ['deploy-tool', '--mode', '{mode}', '--tag', '{tag}'],
      params: [
        { name: 'mode', values: ['fast', 'safe'] },
        { name: 'tag', values: ['v1', 'v2'] },
      ],
      timeoutSeconds: 10,
      auto: true,
      verifyCheckId: 'web-health',
    }
    fc.assert(
      fc.property(
        fc.constantFrom('fast', 'safe'),
        fc.constantFrom('v1', 'v2'),
        fc.string().filter((value) => !['fast', 'safe'].includes(value)),
        (mode, tag, invalid) => {
          expect(actionArgv(action, { mode, tag })).toEqual([
            'deploy-tool',
            '--mode',
            mode,
            '--tag',
            tag,
          ])
          expect(() => actionArgv(action, { mode, tag, extra: 'x' })).toThrow()
          expect(() => actionArgv(action, { mode: invalid, tag })).toThrow()
          expect(() => actionArgv(action, { tag })).toThrow()
        },
      ),
      propertyOptions(RUNS),
    )
  })

  it('changes candidate identity whenever a material changes', () => {
    const base = fc.record({
      planVersion: fc.integer({ min: 1, max: 20 }),
      requirementVersion: fc.integer({ min: 1, max: 20 }),
      baselineCommit: fc.stringMatching(/^[a-f0-9]{7,40}$/),
      candidateHashes: fc.uniqueArray(fc.stringMatching(/^[a-f0-9]{8,16}$/), {
        minLength: 1,
        maxLength: 4,
      }),
    })
    fc.assert(
      fc.property(base, (input) => {
        const identity = candidateIdentityOf(input)
        expect(candidateIdentityOf({ ...input })).toBe(identity)
        expect(candidateIdentityOf({ ...input, planVersion: input.planVersion + 1 })).not.toBe(
          identity,
        )
        expect(
          candidateIdentityOf({ ...input, requirementVersion: input.requirementVersion + 1 }),
        ).not.toBe(identity)
        expect(
          candidateIdentityOf({ ...input, baselineCommit: `${input.baselineCommit}f` }),
        ).not.toBe(identity)
        expect(
          candidateIdentityOf({
            ...input,
            candidateHashes: input.candidateHashes.map((hash, index) =>
              index === 0 ? `${hash}x` : hash,
            ),
          }),
        ).not.toBe(identity)
      }),
      propertyOptions(RUNS),
    )
  })

  it('keeps acceptance binding deterministic for identical materials', () => {
    const artifact = (
      taskId: string,
      testEvidenceSha256: string,
      reviewSha256: string,
    ): TaskArtifact => ({
      requirementId: 'req-1',
      planVersion: 1,
      taskId,
      candidateSha256: 'a'.repeat(64),
      testEvidenceSha256,
      reviewSha256,
      acceptance: 'ok',
      authorizationSource: 'plan-approval:req-1:v1:owner',
      recordedAt: '2026-11-01T00:00:00.000Z',
      baselineCommit: 'b'.repeat(40),
    })
    const input = fc.record({
      taskIds: fc.uniqueArray(fc.stringMatching(/^t[0-9]{1,2}$/), { minLength: 1, maxLength: 4 }),
      evidence: fc.array(fc.stringMatching(/^[a-f0-9]{8,16}$/), { minLength: 1, maxLength: 4 }),
      review: fc.array(fc.stringMatching(/^[a-f0-9]{8,16}$/), { minLength: 1, maxLength: 4 }),
    })
    fc.assert(
      fc.property(input, (generated) => {
        const taskIds = generated.taskIds
        const plan = {
          taskPlanId: 'plan-req-1-1',
          requirementId: 'req-1',
          project: 'proj',
          planVersion: 1,
          requirementVersion: 1,
          tasks: taskIds.map((taskId) => ({
            taskId,
            goal: 'g',
            files: ['src/a.ts'],
            acceptance: 'a',
            testCommand: ['npm', 'test'],
            dependsOn: [],
            limits: { limitSeconds: 60, maxFailureRounds: 1 },
            authorizationSource: 'plan-approval:req-1:v1:owner',
          })),
          createdAt: '2026-11-01T00:00:00.000Z',
        }
        const artifacts = taskIds.map((taskId, index) =>
          artifact(taskId, generated.evidence[index] ?? 'e0', generated.review[index] ?? 'r0'),
        )
        const verification = {
          reportSha256: 'v'.repeat(64),
          candidateSha256: 'a'.repeat(64),
        } as VerificationRecord
        const businessReview = { reportSha256: 'b'.repeat(64) } as BusinessReviewRecord
        const binding = buildAcceptanceBinding({
          plan,
          artifacts,
          verification,
          businessReview,
          candidateSha256: 'c'.repeat(64),
        })
        expect(
          buildAcceptanceBinding({
            plan,
            artifacts: [...artifacts].reverse(),
            verification,
            businessReview,
            candidateSha256: 'c'.repeat(64),
          }),
        ).toEqual(binding)
        expect(
          buildAcceptanceBinding({
            plan,
            artifacts,
            verification,
            businessReview,
            artifactSha256: 'd'.repeat(64),
            candidateSha256: 'c'.repeat(64),
          }).artifactSha256,
        ).toBe('d'.repeat(64))
        // 缺少任一任务产物必须失败，不能静默跳过。
        expect(() =>
          buildAcceptanceBinding({
            plan,
            artifacts: artifacts.slice(1),
            verification,
            businessReview,
            candidateSha256: 'c'.repeat(64),
          }),
        ).toThrow()
      }),
      propertyOptions(RUNS),
    )
  })
})

function taskOfPlan(task: { taskId: string; dependsOn: string[] }): PlannedTask {
  return {
    taskId: task.taskId,
    goal: 'g',
    files: ['src/a.ts'],
    acceptance: 'a',
    testCommand: ['npm', 'test'],
    dependsOn: task.dependsOn,
    limits: { limitSeconds: 60, maxFailureRounds: 1 },
    authorizationSource: '',
  }
}
