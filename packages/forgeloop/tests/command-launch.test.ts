import { describe, expect, it } from 'vitest'
import { prepareCommandArgv } from '../src/runtime/command-launch.js'

/**
 * Windows 上 npm/npx/pnpm 是 `.cmd` 包装脚本，Node 不能直接 CreateProcess 启动它们；
 * 真实模型闭环里就因为这个原因反复出现 `spawn npm ENOENT/EPERM/EINVAL`。
 * 这里固定解析规则：.exe 直接执行、.cmd/.bat 交给 cmd.exe、解析不到保留原样。
 */

const PATH = 'C:\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm'

function existsOnly(files: readonly string[]) {
  const set = new Set(files)
  return (path: string): boolean => set.has(path)
}

describe('command launch resolution', () => {
  it('returns argv unchanged on non-Windows platforms', () => {
    expect(
      prepareCommandArgv(['npm', 'run', 'check'], { platform: 'linux', env: { PATH: '/usr/bin' } }),
    ).toEqual(['npm', 'run', 'check'])
  })

  it('runs .exe commands directly by absolute path on Windows', () => {
    const argv = prepareCommandArgv(['npm', 'run', 'check'], {
      platform: 'win32',
      env: { PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      exists: existsOnly(['C:\\nodejs\\npm.exe', 'C:\\nodejs\\npm.cmd']),
    })
    expect(argv).toEqual(['C:\\nodejs\\npm.exe', 'run', 'check'])
  })

  it('wraps .cmd/.bat wrappers with cmd.exe and quotes every argument', () => {
    const argv = prepareCommandArgv(['npm', 'run', 'check', '--workspace', 'a b'], {
      platform: 'win32',
      env: { PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      exists: existsOnly(['C:\\nodejs\\npm.cmd']),
    })
    expect(argv).toEqual([
      'C:\\Windows\\system32\\cmd.exe',
      '/d',
      '/s',
      '/c',
      '"C:\\nodejs\\npm.cmd" "run" "check" "--workspace" "a b"',
    ])
  })

  it('keeps an already-qualified .cmd path wrapped and leaves unknown commands untouched', () => {
    const wrapped = prepareCommandArgv(['C:\\tools\\pnpm.cmd', 'install'], {
      platform: 'win32',
      env: { ComSpec: 'cmd.exe' },
    })
    expect(wrapped).toEqual(['cmd.exe', '/d', '/s', '/c', '"C:\\tools\\pnpm.cmd" "install"'])
    expect(
      prepareCommandArgv(['missing-tool', '--flag'], {
        platform: 'win32',
        env: { PATH },
        exists: () => false,
      }),
    ).toEqual(['missing-tool', '--flag'])
  })

  it('keeps a qualified non-wrapper command and empty argv untouched', () => {
    expect(
      prepareCommandArgv(['C:\\nodejs\\npm.exe', 'run'], { platform: 'win32', env: { PATH } }),
    ).toEqual(['C:\\nodejs\\npm.exe', 'run'])
    expect(prepareCommandArgv([], { platform: 'win32', env: { PATH } })).toEqual([])
    expect(prepareCommandArgv([''], { platform: 'win32', env: { PATH } })).toEqual([''])
  })

  it('falls back to defaults: process env, Path casing, default PATHEXT and cmd.exe', () => {
    // 不给 env 时用 process.env；平台非 win32 时原样返回。
    expect(prepareCommandArgv(['npm', 'run'], { platform: 'linux' })).toEqual(['npm', 'run'])
    // Windows 上 PATH 的大小写变体也要认；缺 ComSpec 时退回 cmd.exe。
    const viaPathCasing = prepareCommandArgv(['npm', 'run'], {
      platform: 'win32',
      env: { Path: 'C:\\nodejs' },
      exists: existsOnly(['C:\\nodejs\\npm.cmd']),
    })
    expect(viaPathCasing.slice(0, 4)).toEqual(['cmd.exe', '/d', '/s', '/c'])
    // 缺 PATHEXT 时按默认扩展名顺序解析。
    const defaulted = prepareCommandArgv(['npm', 'run'], {
      platform: 'win32',
      env: { PATH },
      exists: existsOnly(['C:\\nodejs\\npm.exe']),
    })
    expect(defaulted).toEqual(['C:\\nodejs\\npm.exe', 'run'])
  })

  it.skipIf(process.platform !== 'win32')(
    'resolves a real command from this machine to an absolute executable',
    () => {
      const argv = prepareCommandArgv(['node', '--version'])
      expect(argv[0]).not.toBe('node')
      expect(argv[0]?.toLowerCase()).toMatch(/node\.exe$/)
      expect(argv.slice(1)).toEqual(['--version'])
    },
  )
})
