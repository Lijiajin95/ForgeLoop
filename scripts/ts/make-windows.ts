#!/usr/bin/env node
/**
 * Windows 版 make 入口：提供与 Makefile 同名、同命令的目标，供没有 GNU make 的
 * Windows 开发机执行 `make.cmd check` 等；CI 与 POSIX 仍以 Makefile 为权威入口。
 *
 * 用法：make.cmd <target> [KEY=VALUE ...]
 * 例：make.cmd check
 *     make.cmd check MUTATION=1
 *     make.cmd mutation-shard SHARD=runtime-ops-1
 *     make.cmd worktree-merge BRANCH=feat/foo
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, npmLaunch } from './platform.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const PKG = join(ROOT, 'packages', 'forgeloop')
const env: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: join(ROOT, '.cache', 'npm') }

type Step = () => void

function run(file: string, args: readonly string[]): void {
  const command = launch(file, args)
  const result = spawnSync(command.file, [...command.args], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    ...(command.spawnOptions ?? {}),
  })
  if (result.error) {
    console.error(`[make] 启动失败：${file}：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function npm(args: readonly string[]): void {
  const command = npmLaunch(args)
  run(command.file, command.args)
}

function node(script: string, args: readonly string[] = []): void {
  run(process.execPath, [join(ROOT, 'scripts', 'ts', script), ...args])
}

function npmWorkspace(script: string): Step {
  return () => npm(['run', script, '--workspace', 'forgeloop-dsh'])
}

function param(name: string): string {
  return (env[name] ?? '').trim()
}

function required(name: string, usage: string): string {
  const value = param(name)
  if (!value) {
    console.error(`用法：make.cmd ${usage}`)
    process.exit(1)
  }
  return value
}

function sbom(): void {
  node('sbom.ts')
  mkdirSync(join(PKG, 'dist'), { recursive: true })
  const source = join(ROOT, 'dist', 'sbom.cdx.json')
  if (existsSync(source)) copyFileSync(source, join(PKG, 'dist', 'sbom.cdx.json'))
}

const staticStep: Step = () => {
  typecheck()
  lintStep()
  contracts()
  budget()
  assertions()
  reliabilityRegistry()
}

function typecheck(): void {
  npmWorkspace('typecheck')()
}

function lintStep(): void {
  npm(['run', 'lint'])
}

function contracts(): void {
  node('contracts.ts')
}

function budget(): void {
  node('token-budget.ts')
}

function assertions(): void {
  node('assertion-budget.ts')
}

function reliabilityRegistry(): void {
  node('reliability-registry.ts')
}

function check(): void {
  staticStep()
  npmWorkspace('test')()
  if (param('MUTATION') === '1' || param('FORGELOOP_MUTATION') === '1') {
    console.log('[check] MUTATION=1：追加全量变异测试（慢）')
    mutation()
  }
}

function mutation(): void {
  npmWorkspace('mutation')()
}

function mutationIncremental(): void {
  const args: string[] = []
  if (param('SCOPE')) args.push('--scope', param('SCOPE'))
  if (param('BASE')) args.push('--base', param('BASE'))
  node('mutation-incremental.ts', args)
}

function mutationShard(): void {
  const shard = required(
    'SHARD',
    'mutation-shard SHARD=<domain|records|runtime-execution|runtime-verification|runtime-ops|session|config-agents|entry|all>',
  )
  node('mutation-shard.ts', [shard])
}

function closeHooks(): void {
  run('git', ['config', 'core.hooksPath', '.githooks'])
}

const targets: Record<string, Step> = {
  setup: () => {
    npm(['install', '--cache', join(ROOT, '.cache', 'npm'), '--no-audit', '--no-fund'])
    closeHooks()
  },
  hooks: closeHooks,
  build: npmWorkspace('build'),
  typecheck,
  test: npmWorkspace('test'),
  'test-fast': npmWorkspace('test:fast'),
  'test-slow': npmWorkspace('test:slow'),
  check,
  'check-fast': () => {
    staticStep()
    npmWorkspace('test:fast')()
  },
  'check-static': staticStep,
  precommit: check,
  contracts,
  'architecture-contract': contracts,
  'architecture-contract-check': contracts,
  budget,
  assertions,
  'reliability-registry': reliabilityRegistry,
  sbom,
  package: () => {
    npmWorkspace('build')()
    npmWorkspace('candidate')()
  },
  coverage: npmWorkspace('coverage'),
  mutation,
  'mutation-shard': mutationShard,
  'mutation-merge': () => node('mutation-merge.ts', param('SHARDS') ? [param('SHARDS')] : []),
  'mutation-incremental': mutationIncremental,
  lint: lintStep,
  format: () => npm(['run', 'format:check']),
  'format-write': () =>
    npm([
      'exec',
      '--',
      'prettier',
      '--write',
      'packages/forgeloop/{src,tests}/**/*.ts',
      'scripts/ts/**/*.ts',
    ]),
  'verify-plugin': () => node('verify-plugin.ts'),
  'verify-e2e': () => node('verify-e2e.ts'),
  e2e: () => {
    node('e2e.ts')
    node('e2e-board.ts')
  },
  'real-model-e2e': () => run(process.execPath, [join(ROOT, 'scripts', 'ts', 'real-model-e2e.ts')]),
  'm0-loop-e2e': () => {
    npmWorkspace('build')()
    node('m0-loop-e2e.ts')
  },
  'reliability-report': () => node('reliability-report.ts'),
  'reliability-report-fast': () => node('reliability-report.ts', ['--fast']),
  stability: () => node('stability.ts'),
  'reliability-advanced': () =>
    node('reliability-report-advanced.ts', param('SCOPE') ? ['--scope', param('SCOPE')] : []),
  'worktree-merge': () =>
    node('worktree-merge.ts', [required('BRANCH', 'worktree-merge BRANCH=<branch>')]),
  audit: () => npm(['audit', '--audit-level=high']),
  security: () => npm(['audit', '--audit-level=high']),
}

function help(): void {
  console.log(`Windows make 入口（Makefile 仍是 CI/POSIX 权威）：

  make.cmd setup|hooks            安装依赖 / 安装 .githooks
  make.cmd check [MUTATION=1]     静态检查 + 全量测试（可选全量变异）
  make.cmd check-fast             静态检查 + 快速测试
  make.cmd check-static           typecheck + lint + 契约 + 预算 + 断言 + 可靠性注册表
  make.cmd test|test-fast|test-slow
  make.cmd build|package|coverage
  make.cmd lint|format|format-write
  make.cmd contracts|budget|assertions|reliability-registry
  make.cmd mutation|mutation-shard SHARD=...|mutation-merge [SHARDS=...]
  make.cmd mutation-incremental [SCOPE=incremental|controlled] [BASE=<ref>]
  make.cmd reliability-report|reliability-report-fast|reliability-advanced|stability
  make.cmd verify-plugin|verify-e2e|e2e|real-model-e2e|m0-loop-e2e
  make.cmd worktree-merge BRANCH=<branch>
  make.cmd audit|security`)
}

const args = process.argv.slice(2)
let target = ''
for (const argument of args) {
  const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argument)
  if (assigned) {
    env[assigned[1]!] = assigned[2]
  } else if (!target) {
    target = argument
  } else {
    console.error(`[make] 无法识别的参数：${argument}`)
    process.exit(1)
  }
}

if (target === 'real-model-e2e') env.FORGELOOP_REAL_MODEL = '1'

if (!target || target === 'help') {
  help()
  process.exit(0)
}
const step = targets[target]
if (!step) {
  console.error(`[make] 未知目标：${target}`)
  help()
  process.exit(1)
}
step()
