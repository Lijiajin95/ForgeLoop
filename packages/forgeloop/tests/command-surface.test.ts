import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandSurface, registerCommands } from '../src/commands.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

let dir = ''
let runtime: ForgeLoopRuntime
let coordinator: Coordinator
let surface: CommandSurface

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-commands-'))
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      owner: 'owner',
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
  coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance: false })
  surface = new CommandSurface(runtime, coordinator, config)
})

afterEach(async () => {
  await coordinator.stop()
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

async function run(rawInput: string, agentId?: string) {
  return surface.handle({ rawInput, ...(agentId === undefined ? {} : { agent: { id: agentId } }) })
}

function submitRequirement(text = '命令面测试'): string {
  const submitted = runtime.submit({ text, by: 'owner', source: 'test' })
  return (submitted.data as { reqId: string }).reqId
}

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-1`,
    requirementId: reqId,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-10-23T00:00:01.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '文档存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: '测试存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

describe('slash command dispatch', () => {
  it('prints help for empty input and the help subcommand', async () => {
    expect((await run('')).kind).toBe('success')
    const help = await run('help')
    expect(help.kind).toBe('success')
    expect(help.text).toContain('/fl submit')
    expect(help.text).toContain('/fl config')
  })

  it('rejects unknown subcommands and shows the usage list', async () => {
    const result = await run('nope')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('未知子命令 nope')
  })

  it('reports the status list and one requirement with failure-round detail', async () => {
    const list = await run('status')
    expect(list.kind).toBe('success')
    const reqId = submitRequirement()
    const single = await run(`status ${reqId}`)
    expect(single.kind).toBe('success')
    expect(single.text).toContain('failureRoundDetails')
    expect(single.text).toContain('grantQuota')
  })

  it('submits and revises with explicit usage errors', async () => {
    expect((await run('submit')).text).toContain('用法：/fl submit')
    const submitted = await run('submit 需求原文')
    expect(submitted.kind).toBe('success')
    expect((await run('revise')).text).toContain('用法：/fl revise')
    const reqId = submitRequirement()
    expect((await run(`revise ${reqId} 新原文`)).kind).toBe('success')
  })

  it('queues analyze/plan/advance and validates their arguments', async () => {
    expect((await run('analyze')).text).toContain('用法：/fl analyze')
    expect((await run('plan')).text).toContain('用法：/fl plan')
    expect((await run('advance')).text).toContain('用法：/fl advance')

    const reqId = submitRequirement()
    const queued = await run(`analyze ${reqId}`, 'session-1')
    expect(queued.kind).toBe('success')
    expect(queued.text).toContain('已受理analyze请求')

    const duplicate = await run(`analyze ${reqId} --wait`, 'session-1')
    expect(duplicate.kind).toBe('success')
    expect(duplicate.text).toContain('已等待本轮执行收口')

    expect((await run(`plan ${reqId}`)).kind).toBe('error')
    expect((await run(`advance ${reqId}`)).kind).toBe('error')
  })

  it('shows one requirement and rejects a missing identity', async () => {
    expect((await run('show')).text).toContain('用法：/fl show')
    const reqId = submitRequirement()
    const shown = await run(`show ${reqId}`)
    expect(shown.kind).toBe('success')
    expect(shown.text).toContain(reqId)
  })

  it('prints the impact facts without calling a model by default', async () => {
    expect((await run('impact')).text).toContain('用法：/fl impact')
    const reqId = submitRequirement()
    const impact = await run(`impact ${reqId}`)
    expect(impact.kind).toBe('success')
    expect(impact.text).toContain('影响摘要')
  })

  it('validates plan-show versions', async () => {
    expect((await run('plan-show')).text).toContain('用法：/fl plan-show')
    const reqId = submitRequirement()
    expect((await run(`plan-show ${reqId} 0`)).text).toContain('任务包版本必须是正整数')
    expect((await run(`plan-show ${reqId} abc`)).text).toContain('任务包版本必须是正整数')
    runtime.repo.recordTaskPlan(plan(reqId))
    const shown = await run(`plan-show ${reqId} 1`)
    expect(shown.kind).toBe('success')
  })

  it('validates the approve arguments and reports missing approvals', async () => {
    expect((await run('approve')).text).toContain('用法：/fl approve')
    expect((await run('approve req-1 0')).text).toContain('用法：/fl approve')
    const reqId = submitRequirement()
    expect((await run(`approve ${reqId} 1`)).kind).toBe('error')
    runtime.repo.recordTaskPlan(plan(reqId))
    const approved = await run(`approve ${reqId} 1`)
    expect(approved.kind).toBe('success')
    expect(approved.text).toContain('已批准')
  })

  it('grants extra failure rounds and validates the identity', async () => {
    expect((await run('grant')).text).toContain('用法：/fl grant')
    const reqId = submitRequirement()
    const granted = await run(`grant ${reqId}`)
    expect(granted.kind).toBe('success')
    expect(granted.text).toContain('追加第 2 次')
  })

  it('validates the acceptance artifact digest and refuses undelivered work', async () => {
    expect((await run('accept')).text).toContain('用法：/fl accept')
    const reqId = submitRequirement()
    expect((await run(`accept ${reqId} not-a-digest`)).text).toContain('64 位小写十六进制')
    expect((await run(`accept ${reqId}`)).kind).toBe('error')
  })

  it('validates candidate requests and reports missing deliveries', async () => {
    expect((await run('candidate')).text).toContain('用法：/fl candidate')
    const reqId = submitRequirement()
    const result = await run(`candidate ${reqId}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('plan_missing')
  })

  it('validates evidence and request lookups', async () => {
    expect((await run('evidence')).text).toContain('用法：/fl evidence')
    const reqId = submitRequirement()
    expect((await run(`evidence ${reqId}`)).kind).toBe('error')
    const requests = await run(`requests ${reqId}`)
    expect(requests.kind).toBe('success')
    expect((await run('requests')).kind).toBe('success')
  })

  it('recovers unknown requests only with confirmation', async () => {
    expect((await run('recover')).text).toContain('用法：/fl recover')
    const reqId = submitRequirement()
    expect((await run(`recover ${reqId}`)).text).toContain('没有待核对的请求')
  })

  it('stops and cancels only with an identity, keeping the reasons', async () => {
    expect((await run('stop')).text).toContain('用法：/fl stop')
    expect((await run('cancel')).text).toContain('用法：/fl cancel')
    const stopped = submitRequirement()
    expect((await run(`stop ${stopped} 暂停`)).kind).toBe('success')
    const cancelled = submitRequirement()
    expect((await run(`cancel ${cancelled} 取消`)).kind).toBe('success')
    expect(runtime.repo.cancellation(cancelled)?.reason).toBe('取消')
  })

  it('prints the resolved configuration and coordinator snapshot', async () => {
    const config = await run('config')
    expect(config.kind).toBe('success')
    expect(config.text).toContain('recordsRoot')
    expect(config.text).toContain('coordinator')
  })

  it('turns an unexpected runtime exception into an explicit command failure', async () => {
    const original = runtime.status
    runtime.status = () => {
      throw new Error('boom')
    }
    try {
      const failed = await run('status')
      expect(failed.kind).toBe('error')
      expect(failed.text).toContain('执行失败：boom')
    } finally {
      runtime.status = original
    }
  })
})

describe('command registration', () => {
  it('registers the /fl command and returns its disposer', () => {
    const registered: Array<{ name: string; handler: unknown }> = []
    const disposers = registerCommands(
      {
        register(definition: unknown) {
          registered.push(definition as { name: string; handler: unknown })
          return () => undefined
        },
      },
      surface,
    )
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe('fl')
    expect(registered[0]!.handler).toBeTypeOf('function')
    expect(disposers).toHaveLength(1)
  })
})
