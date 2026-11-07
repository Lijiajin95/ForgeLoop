import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  VerificationCheckRegistry,
  type VerificationCheckActivation,
} from '../src/runtime/verification-checks.js'
import type { VerificationCheckPlan, VerificationPlan } from '../src/domain/verification.js'
import type { TestRunRequest, TestRunResult, runFormalTest } from '../src/runtime/formal-test.js'
import { sha256OfText } from '../src/domain/delivery.js'

/**
 * 覆盖率门禁补充：测试命令执行上下文的拒绝与留证边界。
 * 只通过注册表的公开方法（run/writeControl/writeMaterial/executeControls/snapshot）
 * 观察工具文本、返回数据与落盘材料；覆盖方案外命令、对照自检回滚、
 * 测试材料越界、候选提交变化与工作区损坏等拒绝路径。
 */

const NOW = '2026-11-06T00:00:00.000Z'
const REQ_ID = 'req-check-cov'

let project = ''
const tempDirs: string[] = []

function outerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-check-dir-'))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-check-cov-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

const VALID_PATCH =
  'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n'

function planWith(label: string, overrides: Partial<VerificationCheckPlan> = {}): VerificationPlan {
  return {
    scenarios: [
      {
        scenario: '候选按文档交付',
        acceptanceCriterion: '命令输出证明候选可用',
        method: '执行测试命令',
        required: true,
        checks: [
          {
            label,
            argv: ['node', '-e', 'process.exit(0)'],
            expectedOutput: '',
            expectFailure: false,
            ...overrides,
          },
        ],
      },
    ],
  }
}

function testResult(
  request: TestRunRequest,
  overrides: Partial<TestRunResult> = {},
): TestRunResult {
  const output = overrides.output ?? 'verified ok'
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    logPath: request.logPath,
    logSha256: sha256OfText(output),
    durationMs: 1,
    output,
    ...overrides,
  }
}

interface HarnessOptions {
  plan?: VerificationPlan
  workspace?: string
  formalTest?: (request: TestRunRequest) => Promise<TestRunResult> | TestRunResult
  signal?: AbortSignal
  reqId?: string
  dir?: string
}

function harness(options: HarnessOptions = {}) {
  const workspace = options.workspace ?? project
  const plan = options.plan ?? planWith('smoke')
  const formalTest = options.formalTest ?? ((request: TestRunRequest) => testResult(request))
  const registry = new VerificationCheckRegistry({
    ctx: {} as never,
    formalTest: formalTest as unknown as typeof runFormalTest,
    now: () => NOW,
  })
  const reqId = options.reqId ?? REQ_ID
  const activation: VerificationCheckActivation = {
    reqId,
    candidateSha256: 'a'.repeat(64),
    workspace,
    dir: options.dir ?? join(workspace, '.forgeloop', 'checks'),
    head: options.workspace ? 'b'.repeat(40) : git(workspace, ['rev-parse', 'HEAD']).trim(),
    plan,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: 5_000,
  }
  const handle = registry.activate(activation)
  return { registry, reqId, handle, plan }
}

function controlsLabels(): string[] {
  const controlsPath = join(project, 'verification/controls.json')
  const parsed = JSON.parse(readFileSync(controlsPath, 'utf8')) as {
    controls: Array<{ label: string }>
  }
  return parsed.controls.map((control) => control.label)
}

beforeEach(() => {
  project = makeProject()
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('verification control registration boundaries', () => {
  it('refuses a control for a label outside the plan and an underspecified failure fragment', async () => {
    const { registry, reqId } = harness({ plan: planWith('read') })

    const unknown = await registry.writeControl(reqId, {
      label: 'missing',
      patch: VALID_PATCH,
      expectedFailureOutput: 'target rule broken',
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.text).toBe('命令 missing 不在当前测试方案中；敏感性对照只能绑定方案里的 label。')

    const short = await registry.writeControl(reqId, {
      label: 'read',
      patch: VALID_PATCH,
      expectedFailureOutput: '  short  ',
    })
    expect(short).toEqual({
      ok: false,
      text: 'expected_failure_output 至少 8 个字符，必须能核对到目标业务规则。',
    })
    expect(existsSync(join(project, 'verification/controls.json'))).toBe(false)
  })

  it('refuses a control patch that does not touch business implementation', async () => {
    const { registry, reqId } = harness({ plan: planWith('read') })
    const outcome = await registry.writeControl(reqId, {
      label: 'read',
      patch:
        'diff --git a/verification/check.js b/verification/check.js\n--- a/verification/check.js\n+++ b/verification/check.js\n@@ -1 +1 @@\n-old\n+new\n',
      expectedFailureOutput: 'target rule broken',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('必须触及业务实现')
    expect(existsSync(join(project, 'verification/controls.json'))).toBe(false)
  })

  it('writes and self-checks a control while merging the existing control list', async () => {
    mkdirSync(join(project, 'verification/controls'), { recursive: true })
    writeFileSync(
      join(project, 'verification/controls.json'),
      JSON.stringify({
        controls: [
          {
            label: 'old',
            patch: 'verification/controls/old.patch',
            expected_failure_output: 'old failure evidence',
          },
        ],
      }) + '\n',
      'utf8',
    )
    const { registry, reqId } = harness({
      plan: planWith('read'),
      dir: outerDir(),
      formalTest: (request) =>
        testResult(request, {
          exitCode: 1,
          output: 'target rule broken: expected fixture, got broken',
        }),
    })
    const written = await registry.writeControl(reqId, {
      label: 'read',
      patch: VALID_PATCH,
      expectedFailureOutput: 'target rule broken',
    })
    expect(written.ok, written.text).toBe(true)
    expect(written.text).toContain('已写入并自检通过敏感性对照 verification/controls/read.patch')
    expect(written.text).toContain('受控副本退出码 1')
    expect(written.data).toEqual({ label: 'read', patch: 'verification/controls/read.patch' })
    expect(controlsLabels()).toEqual(['old', 'read'])
    expect(readFileSync(join(project, 'verification/controls/read.patch'), 'utf8')).toBe(
      VALID_PATCH.trimEnd() + '\n',
    )
  })

  it('records a controlled copy without an exit code instead of claiming success', async () => {
    const { registry, reqId } = harness({
      plan: planWith('read'),
      dir: outerDir(),
      formalTest: (request) =>
        testResult(request, {
          exitCode: null,
          output: 'target rule broken: executor unavailable',
        }),
    })
    const written = await registry.writeControl(reqId, {
      label: 'read',
      patch: VALID_PATCH,
      expectedFailureOutput: 'target rule broken',
    })
    // 没有退出码不能算自检通过：对照被撤销，并如实报告退出码缺失。
    expect(written.ok, written.text).toBe(false)
    expect(written.text).toContain('敏感性对照没有取得退出码')
    expect(written.text).toContain('受控副本退出码 null')
  })

  it('rolls back a control whose self-check did not fail on the target rule', async () => {
    const { registry, reqId } = harness({
      plan: planWith('read'),
      dir: outerDir(),
      formalTest: (request) => testResult(request, { exitCode: 1, output: 'unrelated crash' }),
    })
    const outcome = await registry.writeControl(reqId, {
      label: 'read',
      patch: VALID_PATCH,
      expectedFailureOutput: 'target rule broken',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('对照自检未通过，已撤销本次对照')
    expect(outcome.text).toContain('敏感性对照的失败输出未包含目标业务规则证据')
    expect(outcome.data).toEqual({
      label: 'read',
      issues: ['敏感性对照的失败输出未包含目标业务规则证据：read（预期 target rule broken）'],
    })
    expect(controlsLabels()).toEqual([])
    expect(existsSync(join(project, 'verification/controls/read.patch'))).toBe(false)
  })

  it('refuses the control write when the verification directory cannot be created', async () => {
    writeFileSync(join(project, 'verification'), 'not a directory\n', 'utf8')
    const { registry, reqId } = harness({ plan: planWith('read') })
    const outcome = await registry.writeControl(reqId, {
      label: 'read',
      patch: VALID_PATCH,
      expectedFailureOutput: 'target rule broken',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('写入敏感性对照失败：')
  })
})

describe('verification material boundaries', () => {
  it('refuses material outside verification/ and material that overwrites controls', async () => {
    const { registry, reqId } = harness()
    const outside = registry.writeMaterial(reqId, { path: 'docs/check.js', content: 'x' })
    expect(outside).toEqual({
      ok: false,
      text: '测试材料只能写到 verification/ 下，且不能覆盖 controls/；对照补丁请用敏感性对照工具。',
    })
    const escape = registry.writeMaterial(reqId, {
      path: 'verification/../src/a.ts',
      content: 'x',
    })
    expect(escape.text).toBe(
      '测试材料只能写到 verification/ 下，且不能覆盖 controls/；对照补丁请用敏感性对照工具。',
    )
    const controls = registry.writeMaterial(reqId, {
      path: 'verification/controls/fault.patch',
      content: 'x',
    })
    expect(controls.text).toBe(
      '测试材料只能写到 verification/ 下，且不能覆盖 controls/；对照补丁请用敏感性对照工具。',
    )
    const missing = registry.writeMaterial('req-missing', {
      path: 'verification/a.js',
      content: 'x',
    })
    expect(missing.text).toBe('没有正在进行的验证：req-missing。只有测试会话可以写入测试材料。')
  })

  it('writes nested material under verification/ and reports a failed write', async () => {
    const { registry, reqId } = harness()
    const written = registry.writeMaterial(reqId, {
      path: '/verification/nested/check.js',
      content: 'console.log("ok")\n',
    })
    expect(written).toEqual({
      ok: true,
      text: '已写入测试材料 verification/nested/check.js。',
      data: { path: 'verification/nested/check.js' },
    })
    expect(readFileSync(join(project, 'verification/nested/check.js'), 'utf8')).toBe(
      'console.log("ok")\n',
    )

    writeFileSync(join(project, 'verification/blocker'), 'file blocks directory\n', 'utf8')
    const failed = registry.writeMaterial(reqId, {
      path: 'verification/blocker/child.js',
      content: 'x',
    })
    expect(failed.ok).toBe(false)
    expect(failed.text).toContain('写入测试材料失败：')
  })
})

describe('verification check execution integrity', () => {
  it('uses a safe log name for a label that is not filesystem friendly', async () => {
    const dir = join(project, '.forgeloop', 'checks')
    const { registry, reqId } = harness({
      plan: planWith(''),
      dir,
      formalTest: (request) => testResult(request),
    })
    const outcome = await registry.run(reqId, '')
    expect(outcome.ok).toBe(true)
    expect(outcome.data).toMatchObject({
      label: '',
      logPath: join(dir, 'verification-1-check.log'),
    })
    expect(outcome.text).toContain('日志：' + join(dir, 'verification-1-check.log'))
  })

  it('blocks execution when the candidate Git metadata cannot be read', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'forgeloop-not-git-'))
    try {
      const { registry, reqId } = harness({ workspace: plain, plan: planWith('smoke') })
      const outcome = await registry.run(reqId, 'smoke')
      expect(outcome.ok).toBe(false)
      expect(outcome.text).toBe('候选提交在验证开始后发生变化；本次命令没有执行，验证将被阻断。')
      expect(outcome.data).toMatchObject({
        label: 'smoke',
        integrityIssues: ['无法读取候选提交；测试工作区可能已损坏', '验证期间候选提交发生变化'],
      })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('flags a candidate commit that moved during the command', async () => {
    const { registry, reqId } = harness({
      plan: planWith('smoke'),
      formalTest: (request) => {
        git(project, ['commit', '-qm', 'moved during verification', '--allow-empty'])
        return testResult(request)
      },
    })
    const outcome = await registry.run(reqId, 'smoke')
    expect(outcome.ok).toBe(true)
    expect(outcome.data).toMatchObject({
      integrityIssues: ['验证期间候选提交发生变化'],
    })
    expect(outcome.text).toContain('候选完整性告警：验证期间候选提交发生变化')
  })

  it('records a damaged workspace instead of silently accepting the run', async () => {
    const { registry, reqId } = harness({
      plan: planWith('smoke'),
      formalTest: (request) => {
        rmSync(join(project, '.git'), { recursive: true, force: true })
        return testResult(request)
      },
    })
    const outcome = await registry.run(reqId, 'smoke')
    expect(outcome.ok).toBe(true)
    const issues = (outcome.data?.integrityIssues ?? []) as string[]
    expect(issues).toContain('无法读取候选提交；测试工作区可能已损坏')
    expect(issues.some((issue) => issue.startsWith('无法核对候选完整性：'))).toBe(true)
  })

  it('returns null for controls when the requirement or token no longer matches', async () => {
    const { registry, reqId, handle, plan } = harness()
    const commands = plan.scenarios.flatMap((scenario) => scenario.checks)
    expect(
      await registry.executeControls('req-missing', handle.token, { commands, controls: [] }),
    ).toBeNull()
    expect(
      await registry.executeControls(reqId, 'stale-token', { commands, controls: [] }),
    ).toBeNull()
    expect(await registry.executeControls(reqId, handle.token, { commands, controls: [] })).toEqual(
      {
        results: [],
        issues: [],
      },
    )
  })
})
