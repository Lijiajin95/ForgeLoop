/**
 * 单消费者锁：同一记录根同时只允许一个宿主协调器领取工作。
 *
 * 目录创建是原子的：`mkdir(lockDir)` 成功即获得所有权；存在时读取持有者进程，
 * 进程已退出视为残留并清理一次。第二个宿主仍可提供只读命令，但不得领取请求、
 * 不得把别人的在途请求标为 unknown。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HostLock {
  readonly acquired: boolean
  readonly path: string
  readonly holder: string
  readonly reason: string
  release(): void
}

interface LockRecord {
  owner: string
  pid: number
  acquiredAt: string
}

function readHolder(lockDir: string): { record: LockRecord | null; raw: string } {
  const file = join(lockDir, 'owner.json')
  if (!existsSync(file)) return { record: null, raw: '' }
  try {
    const raw = readFileSync(file, 'utf8')
    return { record: JSON.parse(raw) as LockRecord, raw }
  } catch {
    return { record: null, raw: '' }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireHostLock(lockRoot: string, owner: string): HostLock {
  const lockDir = join(lockRoot, 'host.lock')
  const tryAcquire = (): boolean => {
    try {
      mkdirSync(lockDir)
      const record: LockRecord = { owner, pid: process.pid, acquiredAt: new Date().toISOString() }
      writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify(record)}\n`, 'utf8')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return false
    }
  }

  if (!tryAcquire()) {
    const { record } = readHolder(lockDir)
    if (record && processAlive(record.pid) && record.owner !== owner) {
      return {
        acquired: false,
        path: lockDir,
        holder: `${record.owner} pid=${record.pid} since=${record.acquiredAt}`,
        reason: '另一个宿主正在消费同一记录根；本宿主不领取工作',
        release: () => undefined,
      }
    }
    // 残留锁：清理后只重试一次，避免并发进程互相删除。
    rmSync(lockDir, { recursive: true, force: true })
    if (!tryAcquire()) {
      const holder = readHolder(lockDir)
      return {
        acquired: false,
        path: lockDir,
        holder: holder.raw.trim() || '未知持有者',
        reason: '竞态中未能取得单消费者锁；本宿主不领取工作',
        release: () => undefined,
      }
    }
  }

  let released = false
  return {
    acquired: true,
    path: lockDir,
    holder: `${owner} pid=${process.pid}`,
    reason: '',
    release: () => {
      if (released) return
      released = true
      const { record } = readHolder(lockDir)
      // 只删除自己持有的锁；不清理其他进程的现场。
      if (!record || (record.owner === owner && record.pid === process.pid)) {
        rmSync(lockDir, { recursive: true, force: true })
      }
    },
  }
}