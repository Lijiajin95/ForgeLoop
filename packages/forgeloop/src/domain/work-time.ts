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
