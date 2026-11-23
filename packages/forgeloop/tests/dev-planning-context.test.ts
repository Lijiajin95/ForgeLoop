import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ExecutionDev } from '../src/runtime/execution-dev.js'
import type { AgentSession } from '../src/runtime/agent-runner.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'

const NOW = '2026-11-23T12:00:00.000Z'
const REQ_ID = 'req-planning-facts'

let dir = ''
let repo: Repository
let requirement: Requirement
let analysis: RequirementAnalysis

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-planning-facts-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
  requirement = {
    reqId: REQ_ID,
    project: 'demo',
    status: 'specified',
    blockedReason: '',
    versions: [
      {
        version: 1,
        text: '给一个非 ForgeLoop 项目加导出功能',
        createdAt: NOW,
        revisedBy: 'owner',
        source: 'test',
      },
    ],
    submittedBy: 'owner',
    source: 'test',
  }
  analysis = {
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '支持导出',
    scenarios: ['用户点击导出'],
    businessRules: [],
    exceptions: [],
    nonGoals: [],
    acceptanceCriteria: ['导出文件包含当前列表'],
    clarifications: [],
  }
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

function devWith(engineeringFacts: readonly string[]): ExecutionDev {
  const config: ForgeLoopConfig = resolveConfig(
    {
      project: 'demo',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      engineeringFacts: [...engineeringFacts],
    },
    dir,
  )
  return new ExecutionDev({
    config,
    repo,
    now: () => NOW,
    recordRun: () => undefined,
    previousTaskFailure: () => '',
    formalTest: (() => {
      throw new Error('planning must not run a formal test')
    }) as never,
    existingPackages: () => [],
    ctx: {},
    authorizedPlan: (plan) => plan,
    applyDiffFile: () => ({ ok: true, detail: '' }),
  })
}

/** 只读规划回合：抓取提示词后按中止收口，避免依赖任务包解析。 */
function capturePlanningPrompt(): { session: AgentSession; prompt: () => string } {
  let captured = ''
  return {
    prompt: () => captured,
    session: {
      sessionId: 'session-planning',
      async send(turn) {
        captured = turn.prompt
        return {
          status: 'aborted',
          text: '',
          sessionId: 'session-planning',
          reason: '测试只校验提示词',
          transcriptPath: turn.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      },
      async close() {},
    },
  }
}

describe('dev planning context', () => {
  it('gives the configured engineering facts to the planning turn', async () => {
    const { session, prompt } = capturePlanningPrompt()
    const outcome = await devWith([
      '源码在 src/app/（TypeScript）',
      '检查命令：["npm","test"]',
    ]).planInDevSession({
      reqId: REQ_ID,
      requirement,
      analysis,
      session,
      authorizationSource: 'system-admission:test',
      signal: new AbortController().signal,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'interrupted' })
    expect(prompt()).toContain('- 源码在 src/app/（TypeScript）')
    expect(prompt()).toContain('- 检查命令：["npm","test"]')
    expect(prompt()).not.toContain('插件活动源码在 packages/forgeloop/src/')
  })

  it('keeps the built-in layout facts when the project configures none', async () => {
    const { session, prompt } = capturePlanningPrompt()
    await devWith([]).planInDevSession({
      reqId: REQ_ID,
      requirement,
      analysis,
      session,
      authorizationSource: 'system-admission:test',
      signal: new AbortController().signal,
    })

    expect(prompt()).toContain('- 插件活动源码在 packages/forgeloop/src/')
  })
})
