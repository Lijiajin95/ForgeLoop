import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AdmissionDecision } from '../src/domain/admission.js'

/**
 * 需求详情对外契约：
 * - runtime.requirementDetail 与 Web 看板 detail 端点都稳定返回 admission/commit；
 * - 旧需求（无准入、无提交）返回 null，不抛错；
 * - 详情只读，不携带批准、推进、验收等动作字段。
 */

interface EvidenceView {
  readonly admission: {
    readonly decision: 'admit' | 'block'
    readonly code: string
    readonly reason: string
    readonly createdAt: string
  } | null
  readonly commit: {
    readonly commitSha: string
    readonly commitMessage: string
    readonly files: readonly string[]
    readonly committedAt: string
  } | null
}

interface RegisteredRoute {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** 详情不提供任何写动作；这些顶层字段名一旦出现即视为契约回归。 */
const ACTION_FIELDS = [
  'actions',
  'approve',
  'advance',
  'verify',
  'accept',
  'retry',
  'stop',
  'cancel',
  'build',
  'deploy',
  'requeue',
] as const

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-detail-contract-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function recordsPath(): string {
  return join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite')
}

function withRepository<T>(run: (repository: Repository) => T): T {
  const repository = new Repository(Database.open(recordsPath()))
  try {
    return run(repository)
  } finally {
    repository.close()
  }
}

function seedRequirement(reqId: string): void {
  withRepository((repository) => {
    repository.submit({
      reqId,
      project: 'testproj',
      text: '需求详情契约',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-31T00:00:00.000Z',
    })
  })
}

function admissionDecision(admit: boolean, code: string, reason: string): AdmissionDecision {
  return {
    admit,
    code,
    reason,
    basis: {
      policyVersion: 'test-policy',
      source: 'test',
      submittedBy: 'owner',
      owner: 'owner',
      project: 'testproj',
      projectPath: dir,
      requirementVersion: 1,
      analysisVersion: 1,
      trustedSource: true,
      codeCommitAllowed: admit,
    },
  }
}

function seedAdmission(reqId: string, createdAt = '2026-10-31T01:00:00.000Z'): void {
  withRepository((repository) => {
    repository.recordAdmission({
      requirementId: reqId,
      requirementVersion: 1,
      decision: admissionDecision(true, 'admitted', '可信来源与需求说明齐备'),
      decidedBy: 'system',
      createdAt,
    })
  })
}

function seedCommit(reqId: string, committedAt = '2026-10-31T02:00:00.000Z'): void {
  withRepository((repository) => {
    repository.recordCommit({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'candidate-sha',
      commitSha: 'abcdef1234567890',
      commitMessage: 'feat: 受控提交',
      checkCommand: ['npx', 'vitest', 'run'],
      checkLogPath: join(dir, 'check.log'),
      checkSha256: 'check-sha',
      files: ['packages/forgeloop/src/a.ts'],
      committedAt,
    })
  })
}

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function fakeHost() {
  const routes: RegisteredRoute[] = []
  let cleanup: (() => unknown) | undefined
  const ctx = {
    agents: {},
    agentLoop: {},
    tools: { register: () => () => {} },
    effect(callback: () => unknown) {
      cleanup = callback() as () => unknown
      return () => {}
    },
    inject(dependencies: string[], callback: (scope: unknown) => void) {
      expect(dependencies).toEqual(['connection'])
      callback({
        connection: {
          fetch: {
            register: (route: RegisteredRoute) => {
              routes.push(route)
              return async () => undefined
            },
          },
        },
        effect: (fn: () => () => void) => {
          fn()
          return () => {}
        },
      })
    },
  }
  return { ctx, routes, cleanup: () => cleanup?.() }
}

function start(host: ReturnType<typeof fakeHost>): void {
  apply(host.ctx as never, {
    recordsRoot: join(dir, '.forgeloop'),
    project: 'testproj',
    projectPath: dir,
    agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
  })
}

function post(body: string): Request {
  return new Request('http://127.0.0.1:1234/api/forgeloop/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

async function fetchDetail(
  route: RegisteredRoute,
  reqId: string,
): Promise<{ ok: boolean; value: Record<string, unknown> }> {
  const response = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId })))
  expect(response.status).toBe(200)
  return (await response.json()) as { ok: boolean; value: Record<string, unknown> }
}

function expectReadOnly(view: Record<string, unknown>): void {
  for (const field of ACTION_FIELDS) expect(view).not.toHaveProperty(field)
  expect(view).not.toHaveProperty('actions')
}

describe('requirement detail evidence contract', () => {
  it('keeps admission and commit present and null for an old requirement through the runtime method', () => {
    seedRequirement('req-old-runtime')
    const runtime = makeRuntime()
    try {
      const result = runtime.requirementDetail('req-old-runtime')
      expect(result.ok, result.message).toBe(true)
      const view = result.data as Record<string, unknown>
      expect(view).toHaveProperty('admission', null)
      expect(view).toHaveProperty('commit', null)
      expectReadOnly(view)
    } finally {
      runtime.close()
    }
  })

  it('returns the recorded evidence through the runtime method', () => {
    seedRequirement('req-full-runtime')
    seedAdmission('req-full-runtime')
    seedCommit('req-full-runtime')
    const runtime = makeRuntime()
    try {
      const result = runtime.requirementDetail('req-full-runtime')
      expect(result.ok, result.message).toBe(true)
      const view = result.data as unknown as EvidenceView
      expect(view.admission).toEqual({
        decision: 'admit',
        code: 'admitted',
        reason: '可信来源与需求说明齐备',
        createdAt: '2026-10-31T01:00:00.000Z',
      })
      expect(view.commit).toEqual({
        commitSha: 'abcdef1234567890',
        commitMessage: 'feat: 受控提交',
        files: ['packages/forgeloop/src/a.ts'],
        committedAt: '2026-10-31T02:00:00.000Z',
      })
    } finally {
      runtime.close()
    }
  })

  it('serves admission and commit from the authenticated board detail route', async () => {
    seedRequirement('req-full-route')
    seedAdmission('req-full-route')
    seedCommit('req-full-route')
    const host = fakeHost()
    start(host)
    try {
      expect(host.routes).toHaveLength(1)
      const body = await fetchDetail(host.routes[0]!, 'req-full-route')
      expect(body.ok).toBe(true)
      expect((body.value as unknown as EvidenceView).admission).toEqual({
        decision: 'admit',
        code: 'admitted',
        reason: '可信来源与需求说明齐备',
        createdAt: '2026-10-31T01:00:00.000Z',
      })
      expect((body.value as unknown as EvidenceView).commit).toEqual({
        commitSha: 'abcdef1234567890',
        commitMessage: 'feat: 受控提交',
        files: ['packages/forgeloop/src/a.ts'],
        committedAt: '2026-10-31T02:00:00.000Z',
      })
      expectReadOnly(body.value)
    } finally {
      await host.cleanup()
    }
  })

  it('serves an old requirement detail with null evidence and no error twice', async () => {
    seedRequirement('req-old-route')
    const host = fakeHost()
    start(host)
    try {
      const first = await fetchDetail(host.routes[0]!, 'req-old-route')
      expect(first.ok).toBe(true)
      expect(first.value).toHaveProperty('admission', null)
      expect(first.value).toHaveProperty('commit', null)
      expectReadOnly(first.value)

      const second = await fetchDetail(host.routes[0]!, 'req-old-route')
      expect(second.ok).toBe(true)
      expect(second.value).toHaveProperty('admission', null)
      expect(second.value).toHaveProperty('commit', null)

      withRepository((repository) => {
        const requirement = repository.getRequirement('req-old-route')!
        expect(requirement.status).toBe('draft')
        expect(requirement.versions).toHaveLength(1)
        expect(repository.admissionsFor('req-old-route')).toEqual([])
        expect(repository.commitsFor('req-old-route')).toEqual([])
        expect(repository.requestsFor('req-old-route')).toEqual([])
      })
    } finally {
      await host.cleanup()
    }
  })
})
