/**
 * 跨平台命令启动解析。
 *
 * Windows 上 `npm`、`npx`、`pnpm` 这类命令不是可执行文件，而是同目录下的 `.cmd` 包装脚本；
 * 直接 `spawn('npm', …)` 会 ENOENT/EINVAL（Node 不能用 CreateProcess 启动 .cmd）。
 * 这里按 PATHEXT 解析出真实文件：`.exe` 直接执行，`.cmd/.bat` 经 `cmd.exe /d /s /c` 执行。
 *
 * 纯函数 + 可注入的 platform/env/exists，便于在任意宿主上测试；非 Windows 原样返回。
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface LaunchOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly exists?: (path: string) => boolean
}

const WRAPPER_EXTENSIONS = ['.cmd', '.bat']
const DIRECT_EXTENSIONS = ['.exe', '.com']

function hasExtension(command: string): boolean {
  return /\.[a-z0-9]+$/i.test(command)
}

function quoteForCmd(part: string): string {
  return `"${part.replaceAll('"', '""')}"`
}

/** 在 PATH 里按 PATHEXT 顺序找第一个存在的候选。 */
function resolveOnPath(
  command: string,
  extensions: readonly string[],
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  for (const extension of extensions) {
    for (const directory of directories) {
      const candidate = join(directory, `${command}${extension}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** 把 `.cmd/.bat` 命令包成 `cmd.exe /d /s /c "<file>" "arg"…`。 */
function wrapWithCommandShell(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const shell = env.ComSpec?.trim() || 'cmd.exe'
  const commandLine = [quoteForCmd(file), ...args.map(quoteForCmd)].join(' ')
  return [shell, '/d', '/s', '/c', commandLine]
}

/**
 * 返回真正可以交给 `spawn` 的 argv。
 * Windows 下：`.exe` 解析成绝对路径；`.cmd/.bat` 包到 cmd.exe；解析不到时保留原样，
 * 让调用方看到原始失败原因，而不是悄悄换命令。
 */
export function prepareCommandArgv(argv: readonly string[], options: LaunchOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  if (platform !== 'win32' || argv.length === 0) return [...argv]
  const command = argv[0] ?? ''
  const rest = argv.slice(1)
  if (command === '') return [...argv]
  if (hasExtension(command)) {
    return WRAPPER_EXTENSIONS.some((extension) => command.toLowerCase().endsWith(extension))
      ? wrapWithCommandShell(command, rest, env)
      : [...argv]
  }
  const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  const direct = resolveOnPath(
    command,
    pathext.filter((extension) => DIRECT_EXTENSIONS.includes(extension)),
    env,
    exists,
  )
  if (direct) return [direct, ...rest]
  const wrapper = resolveOnPath(
    command,
    pathext.filter((extension) => WRAPPER_EXTENSIONS.includes(extension)),
    env,
    exists,
  )
  if (wrapper) return wrapWithCommandShell(wrapper, rest, env)
  return [...argv]
}
