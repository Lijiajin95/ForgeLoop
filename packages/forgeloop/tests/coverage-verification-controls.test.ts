import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeVerificationControls } from '../src/runtime/verification-controls.js'
import type { ControlCommandRun } from '../src/runtime/verification-controls.js'
import type { VerificationControlSpec } from '../src/domain/verification-controls.js'

/**
 * 敏感性对照的执行边界：中止、超时、证据不匹配、补丁无法应用、依赖链接失败与执行异常
 * 都必须通过公开入口体现在 issues / results 的真实文案与字段上，不能伪造成敏感性证明。
 */

const PATCH_OK = [
  'diff --git a/business.txt b/business.txt',
  '--- a/business.txt',
  '+++ b/business.txt',
  '@@ -1 +1 @@',
  '-ok',
  '+broken',
  '',
].join('\n')

const PATCH_MISMATCH = [
  'diff --git a/business.txt b/business.txt',
  '--- a/business.txt',
  '+++ b/business.txt',
  '@@ -1 +1 @@',
  '-original',
  '+broken',
  '',
].join('\n')

const PATCH_TEST_ONLY = [
  'diff --git a/verification/check.js b/verification/check.js',
  '--- a/verification/check.js',
  '+++ b/verification/check.js',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n')

const CONTROL: VerificationControlSpec = {
  label: 'check',
  patch: 'verification/controls/fault.patch',
  expectedFailureOutput: 'target rule broken',
}

const roots: string[] = []
const originalPath = process.env.PATH

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' })
}

/** 真实临时 Git 仓库：候选工作区有一份已提交的业务文件与对照补丁。 */
function workspace(patch = PATCH_OK): { root: string; ws: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-controls-cov-'))
  roots.push(root)
  const ws = join(root, 'workspace')
  mkdirSync(join(ws, 'verification', 'controls'), { recursive: true })
  writeFileSync(join(ws, 'business.txt'), 'ok\n', 'utf8')
  writeFileSync(join(ws, 'verification', 'controls', 'fault.patch'), patch, 'utf8')
  git(ws, ['init', '-q'])
  git(ws, ['add', '-A'])
  git(ws, [
    '-c',
    'user.email=forgeloop@example.invalid',
    '-c',
    'user.name=ForgeLoop',
    'commit',
    '-qm',
    'base',
  ])
  return { root, ws }
}

function controlRun(overrides: Partial<ControlCommandRun> = {}): ControlCommandRun {
  return {
    exitCode: 1,
    timedOut: false,
    aborted: false,
    durationMs: 7,
    output: 'target rule broken: expected ok',
    logPath: '/tmp/control.log',
    logSha256: 'sha256-control',
    ...overrides,
  }
}

async function execute(input: {
  root: string
  ws: string
  dir?: string
  commandLabel?: string
  controls?: readonly VerificationControlSpec[]
  dependencyRoot?: string
  run?: (call: {
    argv: readonly string[]
    cwd: string
    logPath: string
  }) => Promise<ControlCommandRun>
}): Promise<Awaited<ReturnType<typeof executeVerificationControls>>> {
  const label = input.commandLabel ?? 'check'
  return executeVerificationControls({
    workspace: input.ws,
    dir: input.dir ?? join(input.root, 'attempt'),
    commands: [{ label, argv: ['node', 'check.js'] }],
    controls: input.controls ?? [CONTROL],
    ...(input.dependencyRoot ? { dependencyRoot: input.dependencyRoot } : {}),
    run: input.run ?? (async () => controlRun()),
  })
}

afterEach(() => {
  process.env.PATH = originalPath
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('judging the controlled run', () => {
  it('reports an aborted control run instead of treating it as a sensitivity proof', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({
      root,
      ws,
      run: async () => controlRun({ aborted: true, exitCode: null }),
    })
    expect(outcome.issues).toEqual(['敏感性对照被中止：check'])
    expect(outcome.results[0]).toMatchObject({ applied: true, aborted: true, exitCode: null })
  })

  it('reports a timed out control run', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({
      root,
      ws,
      run: async () => controlRun({ timedOut: true, exitCode: null }),
    })
    expect(outcome.issues).toEqual(['敏感性对照超时：check'])
    expect(outcome.results[0]).toMatchObject({ applied: true, timedOut: true })
  })

  it('rejects a controlled run that still succeeds on the faulty copy', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({
      root,
      ws,
      run: async () => controlRun({ exitCode: 0, output: 'all tests passed' }),
    })
    expect(outcome.issues).toEqual([
      '必过用例在已知错误实现上仍然通过，不能证明它能发现错误行为：check',
    ])
    expect(outcome.results[0]).toMatchObject({
      applied: true,
      exitCode: 0,
      issue: outcome.issues[0],
    })
  })

  it('requires the non-zero output to contain the declared business rule evidence', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({
      root,
      ws,
      run: async () => controlRun({ output: 'AssertionError: unrelated failure', exitCode: 1 }),
    })
    expect(outcome.issues).toEqual([
      '敏感性对照的失败输出未包含目标业务规则证据：check（预期 target rule broken）',
    ])
    expect(outcome.results[0]).toMatchObject({
      applied: true,
      exitCode: 1,
      output: 'AssertionError: unrelated failure',
    })
  })

  it('accepts a non-zero exit whose output is the declared failure text', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({ root, ws })
    expect(outcome.issues).toEqual([])
    expect(outcome.results[0]).toMatchObject({
      applied: true,
      exitCode: 1,
      timedOut: false,
      aborted: false,
      label: 'check',
      patch: 'verification/controls/fault.patch',
    })
  })
})

describe('control names and dependency links', () => {
  it('sanitizes unsafe labels and falls back to control for an empty one', async () => {
    const { root, ws } = workspace()
    const dir = join(root, 'attempt-safe')
    const controls = [
      { ...CONTROL, label: '!!!' },
      { ...CONTROL, label: '' },
    ]
    const outcome = await executeVerificationControls({
      workspace: ws,
      dir,
      commands: controls.map((control) => ({ label: control.label, argv: ['node', 'check.js'] })),
      controls,
      run: async (call) => controlRun({ logPath: call.logPath }),
    })
    expect(outcome.issues).toEqual([])
    // 非法字符逐字替换为下划线，全部可丢弃时回退 'control'。
    expect(outcome.results.map((result) => result.controlDir)).toEqual([
      join(dir, 'controls', '___'),
      join(dir, 'controls', 'control'),
    ])
    expect(outcome.results.map((result) => result.logPath)).toEqual([
      join(dir, 'controls', '___.log'),
      join(dir, 'controls', 'control.log'),
    ])
  })

  it('links node_modules from the workspace into the isolated copy', async () => {
    const { root, ws } = workspace()
    mkdirSync(join(ws, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(ws, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n', 'utf8')
    let linked = false
    let resolved = ''
    const outcome = await execute({
      root,
      ws,
      run: async (call) => {
        const link = join(call.cwd, 'node_modules')
        linked = lstatSync(link).isSymbolicLink()
        resolved = realpathSync(link)
        return controlRun()
      },
    })
    // 断言放在 run 之外：run 抛出的异常会被“对照执行异常”吞掉，看不到真实原因。
    expect(linked).toBe(true)
    expect(resolved).toBe(realpathSync(join(ws, 'node_modules')))
    expect(outcome.issues).toEqual([])
    expect(outcome.results[0]).toMatchObject({ applied: true, exitCode: 1 })
  })

  it('falls back to the dependency root when the workspace has no node_modules', async () => {
    const { root, ws } = workspace()
    const dependencyRoot = join(root, 'dependency')
    mkdirSync(join(dependencyRoot, 'node_modules', 'dep'), { recursive: true })
    let linked = false
    let resolved = ''
    const outcome = await execute({
      root,
      ws,
      dependencyRoot,
      run: async (call) => {
        const link = join(call.cwd, 'node_modules')
        linked = lstatSync(link).isSymbolicLink()
        resolved = realpathSync(link)
        return controlRun()
      },
    })
    expect(linked).toBe(true)
    expect(resolved).toBe(realpathSync(join(dependencyRoot, 'node_modules')))
    expect(outcome.issues).toEqual([])
  })

  it('keeps the copied node_modules when the link target already exists', async () => {
    const { root, ws } = workspace()
    mkdirSync(join(ws, 'node_modules', 'kept'), { recursive: true })
    writeFileSync(join(ws, 'node_modules', 'kept', 'index.js'), 'module.exports = 2\n', 'utf8')
    // 以 “workspace/.” 传入时复制路径规范化会保留 node_modules，使符号链接目标已存在。
    const outcome = await execute({ root, ws: `${ws}/.` })
    expect(outcome.issues).toEqual([])
    const controlDir = outcome.results[0]!.controlDir
    const modules = join(controlDir, 'node_modules')
    expect(lstatSync(modules).isSymbolicLink()).toBe(false)
    expect(lstatSync(modules).isDirectory()).toBe(true)
    expect(existsSync(join(modules, 'kept', 'index.js'))).toBe(true)
    expect(outcome.results[0]).toMatchObject({ applied: true, exitCode: 1 })
  })
})

describe('failing before the patch can run', () => {
  it('rejects a control that references an undeclared command without a result', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({
      root,
      ws,
      commandLabel: 'other',
      controls: [CONTROL],
      run: async () => controlRun(),
    })
    expect(outcome.issues).toEqual(['敏感性对照引用了未声明的命令：check'])
    expect(outcome.results).toEqual([])
  })

  it('rejects a control whose patch file does not exist', async () => {
    const { root, ws } = workspace()
    const outcome = await execute({
      root,
      ws,
      controls: [{ ...CONTROL, patch: 'verification/controls/absent.patch' }],
      run: async () => controlRun(),
    })
    expect(outcome.issues).toEqual(['敏感性对照补丁不存在：verification/controls/absent.patch'])
    expect(outcome.results).toEqual([])
  })

  it('prefixes patch validation issues with the control label', async () => {
    const { root, ws } = workspace(PATCH_TEST_ONLY)
    const outcome = await execute({ root, ws, run: async () => controlRun() })
    expect(outcome.issues).toEqual([
      'check：敏感性对照不能只修改测试材料，必须触及业务实现：verification/check.js',
    ])
    expect(outcome.results).toEqual([])
  })

  it('reports a patch whose context does not match the candidate', async () => {
    const { root, ws } = workspace(PATCH_MISMATCH)
    const outcome = await execute({ root, ws, run: async () => controlRun() })
    expect(outcome.issues[0]).toMatch(/^敏感性对照补丁无法应用：/)
    expect(outcome.issues[0]).toContain('business.txt')
    expect(outcome.results[0]).toMatchObject({
      applied: false,
      exitCode: null,
      output: '敏感性对照未执行',
      logPath: '',
    })
  })

  it('reports a patch that passes git apply --check but fails to apply', async () => {
    // 用真实 Git 制造“检查通过、应用失败”：把 business.txt 改名到同名目录。
    // 不依赖 POSIX shell，Windows 与 Linux 走同一条判定。
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-controls-cov-'))
    roots.push(root)
    const ws = join(root, 'workspace')
    mkdirSync(join(ws, 'verification', 'controls'), { recursive: true })
    mkdirSync(join(ws, 'blocked.txt'), { recursive: true })
    writeFileSync(join(ws, 'blocked.txt', 'keep.txt'), 'occupied\n', 'utf8')
    writeFileSync(join(ws, 'business.txt'), 'ok\n', 'utf8')
    writeFileSync(
      join(ws, 'verification', 'controls', 'fault.patch'),
      [
        'diff --git a/business.txt b/blocked.txt',
        'similarity index 100%',
        'rename from business.txt',
        'rename to blocked.txt',
        '',
      ].join('\n'),
      'utf8',
    )
    git(ws, ['init', '-q'])
    git(ws, ['add', '-A'])
    git(ws, [
      '-c',
      'user.email=forgeloop@example.invalid',
      '-c',
      'user.name=ForgeLoop',
      'commit',
      '-qm',
      'base',
    ])
    const outcome = await execute({ root, ws })
    expect(outcome.issues[0]).toMatch(/^敏感性对照补丁应用失败：/)
    expect(outcome.issues[0]).toContain('blocked.txt')
    expect(outcome.results[0]).toMatchObject({ applied: false, exitCode: null })
  })

  it('reports a copy that cannot initialize its own Git repository', async () => {
    // 让 git init 必然失败（GIT_DIR 指向普通文件），错误由真实 Git 给出。
    const { root, ws } = workspace()
    const blocker = join(root, 'git-dir-blocker')
    writeFileSync(blocker, 'not a git dir', 'utf8')
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = blocker
    try {
      const outcome = await execute({ root, ws })
      expect(outcome.issues[0]).toMatch(/^敏感性对照执行异常：无法初始化对照副本：/)
      // git 的错误前缀随 locale 变化（fatal: / 致命错误：），只断言“初始化失败并给出原因”。
      expect(outcome.issues[0]).toContain('无法初始化对照副本')
      expect(outcome.results[0]).toMatchObject({ applied: false, exitCode: null })
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })

  it('reports the exception when the isolated copy cannot be created', async () => {
    const { root, ws } = workspace()
    const blocker = join(root, 'attempt-blocked')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const outcome = await execute({ root, ws, dir: blocker, run: async () => controlRun() })
    expect(outcome.issues[0]).toMatch(/^敏感性对照执行异常：.*attempt-blocked/)
    expect(outcome.results[0]).toMatchObject({ applied: false, exitCode: null })
  })

  it('reports an exception thrown by the control command runner', async () => {
    const { root, ws } = workspace()
    let calledWith = ''
    const outcome = await execute({
      root,
      ws,
      run: async (call) => {
        calledWith = call.logPath
        throw new Error('runner exploded')
      },
    })
    expect(outcome.issues).toEqual(['敏感性对照执行异常：runner exploded'])
    expect(calledWith).toBe(join(root, 'attempt', 'controls', 'check.log'))
    expect(outcome.results[0]).toMatchObject({
      applied: true,
      exitCode: null,
      timedOut: false,
      aborted: false,
      output: '敏感性对照未执行',
      logPath: '',
      logSha256: '',
    })
  })
})
