import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { recordsPath, resolveConfig, workspaceDir, type ForgeLoopConfig } from '../src/config.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

let dir = ''
let runtime: ForgeLoopRuntime
let config: ForgeLoopConfig

function planFor(reqId: string): TaskPlan {
  const task = {
    goal: '故障注入任务',
    files: ['src/a.ts'],
    acceptance: '可执行',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [] as string[],
    limits: { limitSeconds: 600, maxFailureRounds: 3 },
    authorizationSource: 'plan-approval:test',
  }
  return {
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    tasks: [
      { ...task, taskId: 't1' },
      { ...task, taskId: 't2', dependsOn: ['t1'] },
    ],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-fi-'))
  config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 3,
      maxVerificationAttempts: 3,
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('fault injection: hard kill after claim', () => {
  it('recovers a SIGKILLed claimant by failing the request and discarding its workspace', async () => {
    const submitted = runtime.submit({ text: '硬杀恢复', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.repo.recordTaskPlan(planFor(reqId))
    runtime.repo.recordRequest({
      requestId: 'rq-killed',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-11-01T00:00:01.000Z',
    })

    const workspace = workspaceDir(config, reqId, 1, 't1')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'partial.ts'), '未收口改动', 'utf8')

    const script = `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(process.argv[1])
      db.prepare("UPDATE service_requests SET state='claimed', owner='child', claimed_at=?, attempts=attempts+1 WHERE request_id=? AND state='pending'")
        .run('2026-11-01T00:00:02.000Z', process.argv[2])
      process.kill(process.pid, 'SIGKILL')
    `
    const signal = await new Promise<string | null>((resolve) => {
      const child = spawn(process.execPath, ['-e', script, recordsPath(config), 'rq-killed'], {
        stdio: 'ignore',
      })
      child.on('exit', (_code, sig) => resolve(sig))
    })
    expect(signal).toBe('SIGKILL')
    expect(runtime.repo.request('rq-killed')?.state).toBe('claimed')
    expect(existsSync(join(workspace, 'partial.ts'))).toBe(true)

    const recovery = runtime.recoverInterrupted('2026-11-01T00:00:03.000Z')
    expect(recovery.interruptedRequests).toContain('rq-killed')
    expect(recovery.discardedWorkspaces).toContain(workspace)
    expect(existsSync(join(workspace, 'partial.ts'))).toBe(false)
    const request = runtime.repo.request('rq-killed')!
    expect(request.state).toBe('failed')
    expect(request.detail).toContain('宿主中断')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })
})
