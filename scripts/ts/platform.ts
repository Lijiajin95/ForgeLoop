/**
 * 平台适配：Windows 上 npm / dsh 等命令是 `.cmd` 包装，`child_process` 不能直接
 * 执行；统一在这里决定启动方式，避免每个脚本各写一遍。
 *
 * POSIX 保持原来的 `spawn(file, args)` 行为；Windows 下 `.cmd`/`.bat` 经
 * `cmd.exe /d /s /c` 启动：命令与参数各自加引号，整行再用一层引号包住，
 * 并以 `windowsVerbatimArguments` 交给 Node，避免 Node 对参数二次转义。
 * 调用方必须把 `spawnOptions` 一并传给 `spawn`/`spawnSync`。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync, type ChildProcess } from 'node:child_process'

export const IS_WINDOWS = process.platform === 'win32'

export interface Launch {
  readonly file: string
  readonly args: readonly string[]
  readonly spawnOptions?: { readonly windowsVerbatimArguments?: boolean }
}

function quoteWindowsArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    quoted += `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  quoted += `${'\\'.repeat(backslashes * 2)}"`
  return quoted
}

function windowsExecutable(target: string): string {
  if (/\.(?:exe|cmd|bat)$/i.test(target)) return target
  const withCommandExtension = `${target}.cmd`
  if (!target.includes('/') && !target.includes('\\')) return withCommandExtension
  return existsSync(withCommandExtension) ? withCommandExtension : target
}

/** 把命令与参数转换成当前平台可启动的形式。 */
export function launch(target: string, args: readonly string[]): Launch {
  if (!IS_WINDOWS) return { file: target, args }
  const executable = windowsExecutable(target)
  if (/\.exe$/i.test(executable)) return { file: executable, args }
  const line = [executable, ...args].map(quoteWindowsArg).join(' ')
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    spawnOptions: { windowsVerbatimArguments: true },
  }
}

/** npm 优先用 Node 同目录的 npm-cli.js，避免 PATH 中 npm.cmd 的解析差异。 */
export function npmLaunch(args: readonly string[]): Launch {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] }
  return launch('npm', args)
}

/**
 * 结束一个可能经 cmd.exe 启动的子进程：Windows 下只 kill 包装进程会留下真正的
 * node 子进程，必须按进程树结束。
 */
export function terminate(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  if (IS_WINDOWS) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    if (result.status === 0) return
  }
  child.kill('SIGTERM')
}
