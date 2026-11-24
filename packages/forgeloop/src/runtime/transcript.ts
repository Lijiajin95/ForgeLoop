import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactValue } from './log.js'

export type TranscriptEvent = Record<string, unknown>

/**
 * 宿主 Session 的只读事件窗口。`inheritedEventCount`/`seq`/`snapshotEvents` 与 DSH
 * `Session` 同名同义；它们属于 DSH
 * `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`
 * 标记的同步历史读取，目前没有非废弃的区间入口，迁移依赖宿主提供增量事件订阅或异步分页。
 */
export interface TranscriptSource {
  readonly inheritedEventCount: number
  readonly seq: number
  snapshotEvents(fromSeq: number, toSeqExclusive: number): readonly TranscriptEvent[]
}

/** 每次只读取游标之后的新事件并追加写盘，产物与全量重写逐字节一致。 */
export class TranscriptWriter {
  private cursor: number
  private opened = false
  private readonly seen: TranscriptEvent[] = []

  constructor(
    private readonly path: string,
    private readonly source: TranscriptSource,
  ) {
    this.cursor = source.inheritedEventCount
  }

  /** 追加自上次以来的新事件；返回截至当前的完整事件数组。 */
  flush(): readonly TranscriptEvent[] {
    const end = this.source.seq
    if (this.cursor < end) {
      const fresh = this.source.snapshotEvents(this.cursor, end)
      this.append(`${fresh.map(serialize).join('\n')}\n`)
      this.seen.push(...fresh)
      this.cursor = end
    }
    return this.seen
  }

  /** 回合收尾：补写剩余事件，并保证零事件时仍留下与旧实现相同的单个换行。 */
  finish(): readonly TranscriptEvent[] {
    this.flush()
    if (!this.opened) this.write('\n')
    return this.seen
  }

  /** 活动快照是观测数据：写盘失败不能中断 Agent 回合。 */
  flushQuietly(): readonly TranscriptEvent[] {
    try {
      return this.flush()
    } catch {
      return this.seen
    }
  }

  get events(): readonly TranscriptEvent[] {
    return this.seen
  }

  private append(chunk: string): void {
    if (!this.opened) this.write('')
    appendFileSync(this.path, chunk, 'utf8')
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // Windows 上无 POSIX 权限位；失败不影响写入。
    }
  }

  private write(text: string): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, text, 'utf8')
    this.opened = true
  }
}

function serialize(event: TranscriptEvent): string {
  return JSON.stringify(redactValue(event))
}
