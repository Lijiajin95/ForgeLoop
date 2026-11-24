import { describe, expect, it } from 'vitest'
import { prepareCommand } from '../src/runtime/command-launch.js'

/**
 * Windows 上 npm/npx/pnpm 是 `.cmd` 包装脚本，Node 不能直接 CreateProcess 启动它们；
 * 真实模型闭环里就因为这个原因反复出现 `spawn npm ENOENT/EPERM/EINVAL`。
 * 这里固定解析规则：.exe 直接执行、.cmd/.bat 交给 cmd.exe 原样命令行、解析不到保留原样。
 */

const PATH = 'C:\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm'

function existsOnly(files: readonly string[]) {
  const set = new Set(files)
  return (path: string): boolean => set.has(path)
}

describe('command launch resolution', () => {
  it('returns argv unchanged on non-Windows platforms', () => {
    expect(
      prepareCommand(['npm', 'run', 'check'], { platform: 'linux', env: { PATH: '/usr/bin' } }),
    ).toEqual({ argv: ['npm', 'run', 'check'], windowsVerbatimArguments: false })
  })

  it('runs .exe commands directly by absolute path on Windows', () => {
    const launch = prepareCommand(['npm', 'run', 'check'], {
      platform: 'win32',
      env: { PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      exists: existsOnly(['C:\\nodejs\\npm.exe', 'C:\\nodejs\\npm.cmd']),
    })
    expect(launch).toEqual({
      argv: ['C:\\nodejs\\npm.exe', 'run', 'check'],
      windowsVerbatimArguments: false,
    })
  })

  it('wraps .cmd/.bat wrappers with cmd.exe and one quoted command line', () => {
    const launch = prepareCommand(['npm', 'run', 'check', '--workspace', 'a b'], {
      platform: 'win32',
      env: { PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      exists: existsOnly(['C:\\nodejs\\npm.cmd']),
    })
    expect(launch).toEqual({
      argv: [
        'C:\\Windows\\system32\\cmd.exe',
        '/d',
        '/s',
        '/c',
        '""C:\\nodejs\\npm.cmd" "run" "check" "--workspace" "a b""',
      ],
      windowsVerbatimArguments: true,
    })
  })

  it('keeps an already-qualified .cmd path wrapped and leaves unknown commands untouched', () => {
    const wrapped = prepareCommand(['C:\\tools\\pnpm.cmd', 'install'], {
      platform: 'win32',
      env: { ComSpec: 'cmd.exe' },
    })
    expect(wrapped).toEqual({
      argv: ['cmd.exe', '/d', '/s', '/c', '""C:\\tools\\pnpm.cmd" "install""'],
      windowsVerbatimArguments: true,
    })
    expect(
      prepareCommand(['missing-tool', '--flag'], {
        platform: 'win32',
        env: { PATH },
        exists: () => false,
      }),
    ).toEqual({ argv: ['missing-tool', '--flag'], windowsVerbatimArguments: false })
  })

  it('keeps a qualified non-wrapper command and empty argv untouched', () => {
    expect(
      prepareCommand(['C:\\nodejs\\npm.exe', 'run'], { platform: 'win32', env: { PATH } }),
    ).toEqual({ argv: ['C:\\nodejs\\npm.exe', 'run'], windowsVerbatimArguments: false })
    expect(prepareCommand([], { platform: 'win32', env: { PATH } })).toEqual({
      argv: [],
      windowsVerbatimArguments: false,
    })
    expect(prepareCommand([''], { platform: 'win32', env: { PATH } })).toEqual({
      argv: [''],
      windowsVerbatimArguments: false,
    })
  })

  it('falls back to defaults: process env, Path casing, default PATHEXT and cmd.exe', () => {
    expect(prepareCommand(['npm', 'run'], { platform: 'linux' })).toEqual({
      argv: ['npm', 'run'],
      windowsVerbatimArguments: false,
    })
    const viaPathCasing = prepareCommand(['npm', 'run'], {
      platform: 'win32',
      env: { Path: 'C:\\nodejs' },
      exists: existsOnly(['C:\\nodejs\\npm.cmd']),
    })
    expect(viaPathCasing.argv.slice(0, 4)).toEqual(['cmd.exe', '/d', '/s', '/c'])
    expect(viaPathCasing.windowsVerbatimArguments).toBe(true)
    const defaulted = prepareCommand(['npm', 'run'], {
      platform: 'win32',
      env: { PATH },
      exists: existsOnly(['C:\\nodejs\\npm.exe']),
    })
    expect(defaulted).toEqual({
      argv: ['C:\\nodejs\\npm.exe', 'run'],
      windowsVerbatimArguments: false,
    })
  })

  it.skipIf(process.platform !== 'win32')(
    'resolves a real command from this machine to an absolute executable',
    () => {
      const launch = prepareCommand(['node', '--version'])
      expect(launch.argv[0]).not.toBe('node')
      expect(launch.argv[0]?.toLowerCase()).toMatch(/node\.exe$/)
      expect(launch.argv.slice(1)).toEqual(['--version'])
      expect(launch.windowsVerbatimArguments).toBe(false)
    },
  )
})
