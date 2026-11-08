/**
 * 工时累计：同一段墙上时间只计一次。
 *
 * 嵌套计时（外层测试执行包含内层命令补充执行）或补充轮复用首轮起点时，
 * 直接按 `now - startedAt` 相加会把重叠区间重复计入。这里按“已计费到的时刻”裁掉重叠部分。
 */
export function chargeWindow(input: {
  chargedUntilMs: number
  startedAtMs: number
  nowMs: number
}): { seconds: number; chargedUntilMs: number } {
  const from = Math.max(input.startedAtMs, input.chargedUntilMs)
  const to = Math.max(from, input.nowMs)
  return {
    seconds: (to - from) / 1000,
    chargedUntilMs: Math.max(input.chargedUntilMs, to),
  }
}

/**
 * 按需求记录已计费到的时刻：外层与内层、首轮与补充轮共用同一把尺，
 * 重叠区间只累计一次。默认时钟可注入，便于测试。
 */
export class WorkTimeLedger {
  private readonly until = new Map<string, number>()

  constructor(private readonly clock: () => number = () => Date.now()) {}

  take(reqId: string, startedAtMs: number): number {
    const window = chargeWindow({
      chargedUntilMs: this.until.get(reqId) ?? 0,
      startedAtMs,
      nowMs: this.clock(),
    })
    this.until.set(reqId, window.chargedUntilMs)
    return window.seconds
  }
}
