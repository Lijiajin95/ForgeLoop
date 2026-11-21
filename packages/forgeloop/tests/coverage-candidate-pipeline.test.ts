import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { CandidatePipeline } from '../src/runtime/candidate-pipeline.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type { CodeCandidateRecord, VerificationRecord } from '../src/records/rows.js'

const NOW = '2026-11-03T10:00:00.000Z'

let root = ''
let config: ForgeLoopConfig
let pipeline: CandidatePipeline

function plan(): TaskPlan {
  return {
    taskPlanId: 'plan-1',
    requirementId: 'req-1',
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [],
    createdAt: NOW,
  }
}

function candidate(diffPath: string): CodeCandidateRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateVersion: 1,
    candidateSha256: 'c'.repeat(64),
    requirementVersion: 1,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath,
    diffSha256: 'd'.repeat(64),
    createdAt: NOW,
  }
}

function verification(evidenceDir: string): VerificationRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateSha256: 'c'.repeat(64),
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: join(evidenceDir, 'verification.json'),
    reportSha256: 'r'.repeat(64),
    evidenceDir,
    sessionId: 'session-1',
    verifiedAt: NOW,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-candidate-pipeline-'))
  config = resolveConfig({
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
    formalTestTimeoutSeconds: 10,
    candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
    candidatePackageCommand: ['node', '-e', 'process.exit(0)'],
    candidateArtifactPath: 'artifact.json',
  })
  pipeline = new CandidatePipeline({ config } as never)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('candidate pipeline defensive paths', () => {
  it('rejects an artifact whose version disagrees with the package', async () => {
    const dir = join(root, 'build')
    mkdirSync(dir, { recursive: true })
    const tarball = join(dir, 'artifact.tgz')
    writeFileSync(tarball, 'artifact', 'utf8')
    writeFileSync(
      join(dir, 'artifact.json'),
      JSON.stringify({ sha256: sha(tarball), tarball, version: '2.0.0' }),
      'utf8',
    )
    const result = await pipeline['readCandidateArtifact'](dir, '1.0.0')
    expect(result).toMatchObject({
      ok: false,
      result: { ok: false, code: 'artifact_version_mismatch' },
    })
  })

  it('rejects an artifact whose digest disagrees with the manifest', async () => {
    const dir = join(root, 'build')
    mkdirSync(dir, { recursive: true })
    const tarball = join(dir, 'artifact.tgz')
    writeFileSync(tarball, 'artifact', 'utf8')
    writeFileSync(
      join(dir, 'artifact.json'),
      JSON.stringify({ sha256: 'f'.repeat(64), tarball, version: '1.0.0' }),
      'utf8',
    )
    const result = await pipeline['readCandidateArtifact'](dir, '1.0.0')
    expect(result).toMatchObject({
      ok: false,
      result: { ok: false, code: 'artifact_mismatch' },
    })
  })

  it('accepts a matching artifact manifest', async () => {
    const dir = join(root, 'build')
    mkdirSync(dir, { recursive: true })
    const tarball = join(dir, 'artifact.tgz')
    writeFileSync(tarball, 'artifact', 'utf8')
    writeFileSync(
      join(dir, 'artifact.json'),
      JSON.stringify({ sha256: sha(tarball), tarball, version: '1.0.0', files: ['lib/a.js'] }),
      'utf8',
    )
    expect(await pipeline['readCandidateArtifact'](dir, '1.0.0')).toMatchObject({
      ok: true,
      value: { tarball, files: ['lib/a.js'] },
    })
  })

  it('writes the requested version into the candidate package', async () => {
    const dir = join(root, 'build')
    mkdirSync(join(dir, 'packages/forgeloop'), { recursive: true })
    writeFileSync(
      join(dir, 'packages/forgeloop/package.json'),
      JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }),
      'utf8',
    )
    expect(await pipeline['patchCandidateVersion'](dir, undefined)).toBeNull()
    expect(await pipeline['patchCandidateVersion'](dir, '1.2.3')).toBeNull()
    expect(
      JSON.parse(readFileSync(join(dir, 'packages/forgeloop/package.json'), 'utf8')).version,
    ).toBe('1.2.3')
  })

  it('rejects a version patch when the package manifest is missing', async () => {
    const dir = join(root, 'build')
    mkdirSync(dir, { recursive: true })
    expect(await pipeline['patchCandidateVersion'](dir, '1.2.3')).toMatchObject({
      ok: false,
      code: 'package_missing',
    })
  })

  it('rejects a candidate copy without a package manifest', async () => {
    const evidenceDir = join(root, 'evidence')
    const workspace = join(evidenceDir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const diffPath = join(root, 'candidate.diff')
    writeFileSync(diffPath, 'diff', 'utf8')
    const result = await pipeline['prepareCandidateBuild'](
      { reqId: 'req-1' },
      {
        plan: plan(),
        candidate: candidate(diffPath),
        verification: verification(evidenceDir),
        materials: { diffPath, protectedFiles: [] },
      },
    )
    expect(result).toMatchObject({
      ok: false,
      result: { code: 'package_missing' },
    })
  })

  it('rewrites the configured version file instead of a fixed package path', async () => {
    const custom = resolveConfig({
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
      candidatePackageCommand: ['node', '-e', 'process.exit(0)'],
      candidateArtifactPath: 'artifact.json',
      candidateVersionFile: 'package.json',
    })
    const evidenceDir = join(root, 'evidence-custom')
    const workspace = join(evidenceDir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'other-app', version: '1.0.0' }),
      'utf8',
    )
    mkdirSync(join(workspace, '.git'), { recursive: true })
    const diffPath = join(root, 'candidate-custom.diff')
    writeFileSync(diffPath, 'diff', 'utf8')
    const customPipeline = new CandidatePipeline({ config: custom } as never)
    const prepared = await customPipeline['prepareCandidateBuild'](
      { reqId: 'req-1', version: '9.9.9' },
      {
        plan: plan(),
        candidate: candidate(diffPath),
        verification: verification(evidenceDir),
        materials: { diffPath, protectedFiles: [] },
      },
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.packageVersion).toBe('9.9.9')
    const written = JSON.parse(readFileSync(join(prepared.dir, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(written.version).toBe('9.9.9')
  })

  it('skips the version file entirely when none is configured', async () => {
    const noVersion = resolveConfig({
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      candidateBuildCommand: [],
      candidateVersionFile: '',
    })
    const dir = join(root, 'noversion')
    mkdirSync(dir, { recursive: true })
    const pipelineWithout = new CandidatePipeline({ config: noVersion } as never)
    expect(await pipelineWithout['patchCandidateVersion'](dir, '9.9.9')).toBeNull()
    expect(await pipelineWithout['candidateVersionOf'](dir, '3.0.0')).toEqual({
      ok: true,
      packageVersion: '3.0.0',
    })
  })

  it('rejects a candidate with an empty build command', async () => {
    const evidenceDir = join(root, 'evidence')
    const workspace = join(evidenceDir, 'workspace')
    mkdirSync(join(workspace, 'packages/forgeloop'), { recursive: true })
    writeFileSync(
      join(workspace, 'packages/forgeloop/package.json'),
      JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }),
      'utf8',
    )
    const diffPath = join(root, 'candidate.diff')
    writeFileSync(diffPath, 'diff', 'utf8')
    const broken = new CandidatePipeline({
      config: { ...config, candidateBuildCommand: [''] },
    } as never)
    const result = await broken['prepareCandidateBuild'](
      { reqId: 'req-1' },
      {
        plan: plan(),
        candidate: candidate(diffPath),
        verification: verification(evidenceDir),
        materials: { diffPath, protectedFiles: [] },
      },
    )
    expect(result).toMatchObject({
      ok: false,
      result: { code: 'candidate_command_missing' },
    })
  })

  it('reports a failing candidate command and writes its log', async () => {
    const evidenceDir = join(root, 'evidence')
    const workspace = join(evidenceDir, 'workspace')
    mkdirSync(join(workspace, 'packages/forgeloop'), { recursive: true })
    writeFileSync(
      join(workspace, 'packages/forgeloop/package.json'),
      JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }),
      'utf8',
    )
    const diffPath = join(root, 'candidate.diff')
    writeFileSync(diffPath, 'diff', 'utf8')
    const brokenConfig = resolveConfig(
      {
        project: 'demo',
        projectPath: root,
        recordsRoot: join(root, '.forgeloop'),
        formalTestTimeoutSeconds: 10,
        candidateBuildCommand: ['node', '-e', 'process.exit(7)'],
        candidatePackageCommand: ['node', '-e', 'process.exit(0)'],
        candidateArtifactPath: 'artifact.json',
      },
      root,
    )
    const broken = new CandidatePipeline({ config: brokenConfig } as never)
    const result = await broken['prepareCandidateBuild'](
      { reqId: 'req-1' },
      {
        plan: plan(),
        candidate: candidate(diffPath),
        verification: verification(evidenceDir),
        materials: { diffPath, protectedFiles: [] },
      },
    )
    expect(result).toMatchObject({
      ok: false,
      result: { code: 'candidate_build_failed' },
    })
  })

  it('links shared node_modules into the build copy', async () => {
    const evidenceDir = join(root, 'evidence')
    const workspace = join(evidenceDir, 'workspace')
    mkdirSync(join(workspace, 'packages/forgeloop'), { recursive: true })
    writeFileSync(
      join(workspace, 'packages/forgeloop/package.json'),
      JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }),
      'utf8',
    )
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    const diffPath = join(root, 'candidate.diff')
    writeFileSync(diffPath, 'diff', 'utf8')
    const result = await pipeline['prepareCandidateBuild'](
      { reqId: 'req-1' },
      {
        plan: plan(),
        candidate: candidate(diffPath),
        verification: verification(evidenceDir),
        materials: { diffPath, protectedFiles: [] },
      },
    )
    expect(result).toMatchObject({ ok: true, packageVersion: '1.0.0' })
  })
})

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
