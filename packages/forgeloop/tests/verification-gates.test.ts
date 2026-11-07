import { describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { VerificationCheckRegistry } from '../src/runtime/verification-checks.js'
import type { VerificationControlSpec } from '../src/domain/verification-controls.js'
import { sha256OfText } from '../src/domain/delivery.js'

/**
 * 连续推进的验证门禁：同版测试材料、对照有效性、会话身份与符号链接越界。
 * 这些用例只通过验证工具的公开入口观察结果，不复制内部实现。
 */

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-gates-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir })
  return dir
}

const planText = JSON.stringify({
  scenarios: [
    {
      scenario: '交付文档',
      acceptance_criterion: '文档包含标记',
      method: '读取 verification/input.txt',
      required: true,
      checks: [
        {
          label: 'read-input',
          argv: [
            'node',
            '-e',
            "const fs=require('node:fs');const t=fs.readFileSync('verification/input.txt','utf8');if(!t.includes('ok')){console.error('marker-missing');process.exit(1)}console.log('marker-ok')",
          ],
          expected_output: 'marker-ok',
        },
      ],
    },
  ],
})

function harness(
  options: {
    workspace?: string
    formalTest?: ConstructorParameters<typeof VerificationCheckRegistry>[0]['formalTest']
  } = {},
) {
  const dir = options.workspace ?? project()
  const registry = new VerificationCheckRegistry({
    ctx: {},
    formalTest:
      options.formalTest ??
      (async (request) => {
        const { spawn } = await import('node:child_process')
        return await new Promise((resolve) => {
          const child = spawn(request.argv[0] ?? '', request.argv.slice(1), {
            cwd: request.cwd,
            env: process.env,
          })
          let output = ''
          child.stdout.on('data', (chunk) => (output += String(chunk)))
          child.stderr.on('data', (chunk) => (output += String(chunk)))
          child.on('close', (code) => {
            mkdirSync(join(request.logPath, '..'), { recursive: true })
            writeFileSync(request.logPath, output)
            resolve({
              exitCode: code,
              timedOut: false,
              aborted: false,
              logPath: request.logPath,
              logSha256: sha256OfText(output),
              durationMs: 1,
              output,
            })
          })
        })
      }),
    now: () => '2026-11-06T00:00:00.000Z',
  })
  const reqId = 'req-gates'
  mkdirSync(join(dir, 'verification'), { recursive: true })
  writeFileSync(join(dir, 'verification/input.txt'), 'ok\n')
  const handle = registry.activate({
    reqId,
    candidateSha256: 'a'.repeat(64),
    workspace: dir,
    dir: join(dir, '.attempt-1'),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
    plan: JSON.parse(planText),
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    sessionId: 'session-verify',
    attemptId: 'attempt-1',
  })
  return { dir, registry, reqId, handle }
}

const control = (patch = 'verification/controls/fault.patch'): VerificationControlSpec => ({
  label: 'read-input',
  patch,
  expectedFailureOutput: 'marker-missing',
})

describe('verification material freeze', () => {
  it('blocks a control when the positive script changed after the green run', async () => {
    const { dir, registry, reqId, handle } = harness()
    expect((await registry.run(reqId, 'read-input', { sessionId: 'session-verify' })).ok).toBe(true)
    // 换掉同一 label 使用的脚本/输入，再执行对照。
    writeFileSync(join(dir, 'verification/input.txt'), 'changed\n')
    mkdirSync(join(dir, 'verification/controls'), { recursive: true })
    writeFileSync(
      join(dir, 'verification/controls/fault.patch'),
      'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n',
    )
    const outcome = await registry.executeControls(reqId, handle.token, {
      commands: [{ label: 'read-input', argv: ['node', '-e', '0'] }],
      controls: [control()],
    })
    expect(outcome?.issues.join('；')).toContain('验证材料在正向执行后发生变化')
    handle.release()
  })

  it('rejects a control that leaves the command without an exit code', async () => {
    const {
      dir,
      registry,
      reqId,
      handle: initial,
    } = harness({
      formalTest: async (request) => ({
        exitCode: null,
        timedOut: false,
        aborted: false,
        logPath: request.logPath,
        logSha256: sha256OfText('marker-missing'),
        durationMs: 1,
        output: 'marker-missing',
      }),
    })
    initial.release()
    mkdirSync(join(dir, 'verification/controls'), { recursive: true })
    writeFileSync(
      join(dir, 'verification/controls/fault.patch'),
      'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n',
    )
    const handle = registry.activate({
      reqId,
      candidateSha256: 'b'.repeat(64),
      workspace: dir,
      dir: mkdtempSync(join(tmpdir(), 'forgeloop-attempt-')),
      head: 'head',
      plan: JSON.parse(planText),
      signal: new AbortController().signal,
      timeoutMs: 1000,
      sessionId: 'session-null',
    })
    const outcome = await registry.writeControl(
      reqId,
      {
        label: 'read-input',
        patch:
          'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n',
        expectedFailureOutput: 'marker-missing',
      },
      { sessionId: 'session-null' },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('没有取得退出码')
    handle.release()
  })
})

describe('verification tool identity and path confinement', () => {
  it('rejects calls from another verification session', async () => {
    const { registry, reqId, handle } = harness()
    const outcome = await registry.run(reqId, 'read-input', { sessionId: 'other-session' })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('验证会话不一致')
    handle.release()
  })

  it('rejects material writes that escape through a symlink', async () => {
    const { dir, registry, reqId, handle } = harness()
    const outside = mkdtempSync(join(tmpdir(), 'forgeloop-outside-'))
    symlinkSync(outside, join(dir, 'verification/link'))
    const outcome = registry.writeMaterial(
      reqId,
      { path: 'verification/link/escape.js', content: 'x' },
      { sessionId: 'session-verify' },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('符号链接')
    expect(existsSync(join(outside, 'escape.js'))).toBe(false)
    expect(lstatSync(join(dir, 'verification/link')).isSymbolicLink()).toBe(true)
    handle.release()
    rmSync(outside, { recursive: true, force: true })
  })
})
