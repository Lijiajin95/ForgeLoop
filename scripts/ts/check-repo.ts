/**
 * 跨平台仓库检查：与 make check 的步骤保持一致，供 commitCheckCommand 在 Linux/Windows 使用。
 * 不依赖 GNU make；npm 与 node 通过 scripts/ts/platform.ts 启动。
 */
import { spawnSync } from 'node:child_process'
import { launch, npmLaunch, type Launch } from './platform.ts'

interface Step {
  readonly name: string
  readonly command: Launch
}

const node = (script: string): Launch => launch(process.execPath, [script])

const steps: readonly Step[] = [
  { name: 'typecheck', command: npmLaunch(['run', 'typecheck', '--workspace', 'forgeloop-dsh']) },
  { name: 'lint', command: npmLaunch(['run', 'lint']) },
  { name: 'contracts', command: node('scripts/ts/contracts.ts') },
  { name: 'budget', command: node('scripts/ts/token-budget.ts') },
  { name: 'assertions', command: node('scripts/ts/assertion-budget.ts') },
  { name: 'reliability-registry', command: node('scripts/ts/reliability-registry.ts') },
  { name: 'test', command: npmLaunch(['run', 'test', '--workspace', 'forgeloop-dsh']) },
]

let failed = false
for (const step of steps) {
  process.stdout.write(`[check-repo] ${step.name}\n`)
  const result = spawnSync(step.command.file, [...step.command.args], {
    stdio: 'inherit',
    ...(step.command.spawnOptions ?? {}),
  })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(`[check-repo] ${step.name} 失败（退出码 ${result.status ?? 'null'}）\n`)
    break
  }
}
if (failed) process.exit(1)
process.stdout.write('[check-repo] 全部通过\n')
