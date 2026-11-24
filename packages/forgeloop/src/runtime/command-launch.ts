import { existsSync } from 'node:fs'
import { delimiter, win32 } from 'node:path'

export interface LaunchOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly exists?: (path: string) => boolean
}

export interface PreparedCommand {
  readonly argv: string[]
  /**
   * Windows 上 cmd.exe 命令行必须原样交给 CreateProcess：
   * Node 默认会给带引号的参数再转义一层，`cmd /c` 收到的是字面量 `\"`。
   */
  readonly windowsVerbatimArguments: boolean
}

const WRAPPER_EXTENSIONS = ['.cmd', '.bat']
const DIRECT_EXTENSIONS = ['.exe', '.com']

function hasExtension(command: string): boolean {
  return /\.[a-z0-9]+$/i.test(command)
}

function quoteForCmd(part: string): string {
  return `"${part.replaceAll('"', '""')}"`
}

function pathCandidates(input: {
  readonly command: string
  readonly extensions: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
}): string[] {
  const pathDelimiter = input.platform === 'win32' ? ';' : delimiter
  const directories = (input.env.PATH ?? input.env.Path ?? '').split(pathDelimiter).filter(Boolean)
  const candidates: string[] = []
  for (const extension of input.extensions) {
    for (const directory of directories) {
      candidates.push(win32.join(directory, `${input.command}${extension}`))
    }
  }
  return candidates
}

function wrapWithCommandShell(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const shell = env.ComSpec?.trim() || 'cmd.exe'
  // 外层引号让 `/s` 只剥掉最外层，路径与参数里的空格原样保留。
  const commandLine = `"${[quoteForCmd(file), ...args.map(quoteForCmd)].join(' ')}"`
  return [shell, '/d', '/s', '/c', commandLine]
}

export function prepareCommand(
  argv: readonly string[],
  options: LaunchOptions = {},
): PreparedCommand {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const plain = (value: readonly string[]): PreparedCommand => ({
    argv: [...value],
    windowsVerbatimArguments: false,
  })
  if (platform !== 'win32' || argv.length === 0) return plain(argv)
  const command = argv[0] ?? ''
  const rest = argv.slice(1)
  if (command === '') return plain(argv)
  if (hasExtension(command)) {
    return WRAPPER_EXTENSIONS.some((extension) => command.toLowerCase().endsWith(extension))
      ? { argv: wrapWithCommandShell(command, rest, env), windowsVerbatimArguments: true }
      : plain(argv)
  }
  const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  const direct = pathCandidates({
    command,
    extensions: pathext.filter((extension) => DIRECT_EXTENSIONS.includes(extension)),
    env,
    platform,
  }).find((candidate) => exists(candidate))
  if (direct) return plain([direct, ...rest])
  const wrapper = pathCandidates({
    command,
    extensions: pathext.filter((extension) => WRAPPER_EXTENSIONS.includes(extension)),
    env,
    platform,
  }).find((candidate) => exists(candidate))
  if (wrapper) {
    return { argv: wrapWithCommandShell(wrapper, rest, env), windowsVerbatimArguments: true }
  }
  return plain(argv)
}
