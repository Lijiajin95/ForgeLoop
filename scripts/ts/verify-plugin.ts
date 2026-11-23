#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { requireVerificationContainer, verificationCandidate } from './verification-container.ts'

requireVerificationContainer()

const root = resolve(import.meta.dirname, '../..')
const stage = mkdtempSync(join(tmpdir(), 'forgeloop-verify-plugin-'))
const home = join(stage, 'dsh-home')
const project = join(stage, 'project')
const records = join(stage, 'records')
const config = join(stage, 'forgeloop.json')
const profile = 'forgeloop-verify-plugin'

function dsh(args: readonly string[]): string {
  const result = spawnSync('dsh', [...args], {
    cwd: project,
    env: { ...process.env, DSH_HOME: home, FORGELOOP_CONFIG: config },
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      'DSH 验证命令失败：' + (result.error?.message ?? result.stderr.trim().slice(-800)),
    )
  }
  return result.stdout
}

try {
  const candidate = verificationCandidate(root)
  for (const dir of [home, project, records]) mkdirSync(dir)
  writeFileSync(
    config,
    JSON.stringify({
      project: 'verify-plugin',
      projectPath: project,
      recordsRoot: records,
      autoAdvance: false,
      ops: { enabled: false },
      deployments: { enabled: false },
    }),
  )
  dsh(['--profile', profile, '--from-default-profile', 'headless', '--dump-config'])
  dsh(['plugin', '--profile', profile, 'add', '--offline', candidate.path])
  const composed = dsh(['--profile', profile, '--dump-config'])
  if (!composed.includes('forgeloop-dsh') || composed.includes('@deepseek-ai/dsh-workspace')) {
    throw new Error('候选未装入本轮 headless profile')
  }
  const output = dsh([
    '--profile',
    profile,
    '--json',
    'Call the forgeloop_status tool with empty arguments, then answer with the tool ok flag.',
  ])
  if (!output.includes('"tool":"forgeloop_status"') || !output.includes('"kind":"completed"')) {
    throw new Error('真实模型未完成 forgeloop_status 工具回合')
  }
  const dbPath = join(records, 'projects', 'verify-plugin', 'records.sqlite')
  if (!existsSync(dbPath)) throw new Error('没有核对到本轮隔离记录库')
  const reports = join(root, 'reports')
  mkdirSync(reports, { recursive: true })
  writeFileSync(
    join(reports, 'verify-plugin.json'),
    JSON.stringify(
      { candidateSha256: candidate.sha256, profile, dbPath, tool: 'forgeloop_status' },
      null,
      2,
    ) + '\n',
  )
  console.log('[verify-plugin] OK：候选在隔离 headless profile 完成真实工具回合')
} finally {
  rmSync(stage, { recursive: true, force: true })
}
