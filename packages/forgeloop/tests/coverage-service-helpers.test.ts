import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import {
  businessReviewEvidenceWindow,
  directorySummaryOf,
  parseFormalTestHeader,
  planReviewBlocking,
  readActivity,
  readJson,
  summarizeActivity,
  verificationBlocking,
  verificationMaterials,
  workspaceChanges,
} from '../src/runtime/service-helpers.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-service-helpers-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function config() {
  return resolveConfig(
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
}

describe('activity summaries', () => {
  it('summarises each known event type from the newest event first', () => {
    expect(summarizeActivity([{ type: 'tool/result' }])).toBe('工具返回结果')
    expect(summarizeActivity([{ type: 'tool/call', data: { name: 'bash' } }])).toBe(
      '正在调用工具 bash',
    )
    expect(summarizeActivity([{ type: 'tool/call', data: {} }])).toBe('正在调用工具 工具')
    expect(summarizeActivity([{ type: 'step/start', data: { step: 3 } }])).toBe('执行步骤 3')
    expect(summarizeActivity([{ type: 'step/start', data: {} }])).toBe('执行步骤')
    expect(summarizeActivity([{ type: 'assistant/message' }])).toBe('模型回复并继续')
    expect(summarizeActivity([{ type: 'turn/start' }])).toBe('回合开始')
    expect(summarizeActivity([{ type: 'turn/end' }])).toBe('回合结束')
    expect(summarizeActivity([{ type: 'unknown' }])).toBe('等待 Agent 活动')
    expect(summarizeActivity([{ type: 42 }, null])).toBe('等待 Agent 活动')
  })

  it('reads valid activity lines, drops corrupt lines and reports truncation', () => {
    const path = join(dir, 'dev.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'tool/call',
          time: Date.parse('2026-11-01T00:00:00.000Z'),
          data: { name: 'bash', arguments: '{"a":1}' },
        }),
        'not json',
        JSON.stringify({ type: 'tool/result' }),
      ].join('\n'),
      'utf8',
    )
    const activity = readActivity(path, 10)
    expect(activity.total).toBe(3)
    expect(activity.items).toHaveLength(2)
    expect(activity.items[0]?.summary).toBe('调用 bash: {"a":1}')
    expect(activity.items[1]?.summary).toBe('工具返回结果')
    expect(readActivity(path, 1).truncated).toBe(true)
    expect(readActivity(join(dir, 'missing.jsonl'), 10)).toEqual({
      items: [],
      total: 0,
      truncated: false,
    })
  })

  it('summarises assistant content and unknown event types', () => {
    const path = join(dir, 'dev.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'hello  world' }] } },
        }),
        JSON.stringify({ type: 'assistant/message', data: { message: { content: [] } } }),
        JSON.stringify({ type: 'step/start', data: { step: 1 } }),
        JSON.stringify({ type: 'turn/start' }),
        JSON.stringify({ type: 'turn/end' }),
        JSON.stringify({ type: 'custom' }),
        JSON.stringify({}),
      ].join('\n'),
      'utf8',
    )
    const summaries = readActivity(path, 20).items.map((item) => item.summary)
    expect(summaries).toEqual([
      '模型回复: hello world',
      '模型回复',
      '步骤 1',
      '回合开始',
      '回合结束',
      'custom',
      'event',
    ])
  })
})

describe('report readers', () => {
  it('reads JSON only when present and parseable', () => {
    expect(readJson(join(dir, 'missing.json'))).toBeNull()
    writeFileSync(join(dir, 'bad.json'), 'not json')
    expect(readJson(join(dir, 'bad.json'))).toBeNull()
    writeFileSync(join(dir, 'ok.json'), '{"a":1}')
    expect(readJson(join(dir, 'ok.json'))).toEqual({ a: 1 })
  })

  it('prefers blocking reasons and falls back to summaries', () => {
    expect(
      planReviewBlocking(
        JSON.stringify({ verdict: 'block', blocking: ['a', 'b'], findings: [], summary: 's' }),
      ),
    ).toBe('a；b')
    expect(
      planReviewBlocking(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: 'ok',
          verification_plan: [
            {
              scenario: 's',
              acceptance_criterion: 'a',
              method: 'm',
              required: true,
            },
          ],
        }),
      ),
    ).toBe('ok')
    expect(planReviewBlocking('bad json')).toBe('bad json')
    expect(
      verificationBlocking(
        JSON.stringify({
          verdict: 'block',
          blocking: ['x'],
          findings: [],
          scenarios: [],
          summary: 's',
        }),
      ),
    ).toBe('x')
    expect(
      verificationBlocking(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          scenarios: [],
          summary: 'ok',
        }),
      ),
    ).toBe('ok')
    expect(verificationBlocking('bad json')).toBe('bad json')
  })

  it('keeps the head and tail of a long evidence window', () => {
    const long = `${'a'.repeat(10)}${'b'.repeat(20)}${'c'.repeat(10)}`
    expect(businessReviewEvidenceWindow(long, 5)).toBe(`aaaaa\n…（中间省略 30 字符）…\nccccc`)
    expect(businessReviewEvidenceWindow('short', 5)).toBe('short')
  })
})

describe('workspace helpers', () => {
  it('fails closed when git status cannot run', () => {
    expect(() => workspaceChanges(join(dir, 'missing'))).toThrow('git status 失败')
  })

  it('lists verification materials recursively and ignores missing roots', () => {
    expect(verificationMaterials(dir)).toEqual([])
    mkdirSync(join(dir, 'workspace', 'verification', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'workspace', 'verification', 'a.txt'), 'a')
    writeFileSync(join(dir, 'workspace', 'verification', 'nested', 'b.txt'), 'bb')
    const materials = verificationMaterials(dir)
    expect(materials.map((item) => item.path)).toEqual([
      'verification/a.txt',
      'verification/nested/b.txt',
    ])
    expect(materials.map((item) => item.bytes)).toEqual([1, 2])
  })
})

describe('formal test headers', () => {
  it('parses every header field and tolerates invalid values', () => {
    expect(
      parseFormalTestHeader(
        'started: 2026-11-01T00:00:00.000Z\nduration_ms: 12\ntimed_out: true\naborted: false\nexit_code: 1\n',
      ),
    ).toEqual({
      startedAt: '2026-11-01T00:00:00.000Z',
      durationMs: 12,
      timedOut: true,
      aborted: false,
      exitCode: 1,
    })
    expect(parseFormalTestHeader('duration_ms: nope\ntimed_out: maybe\nexit_code: nope')).toEqual({
      startedAt: '',
      durationMs: null,
      timedOut: null,
      aborted: null,
      exitCode: null,
    })
  })
})

describe('directory summary', () => {
  it('reports the configured agent when the runner is not an AgentRunner', () => {
    const summary = directorySummaryOf(config(), {}) as {
      agent: { provider: string; model: string }
      autoAdvance: boolean
      projectDir: string
      database: string
    }
    expect(summary.agent).toEqual({ provider: 'fake', model: 'fake' })
    expect(summary.autoAdvance).toBe(false)
    expect(summary.projectDir).toContain('testproj')
    expect(summary.database).toContain('records.sqlite')
  })
})
