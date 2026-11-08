/** 记录各需求最近一次可观测进展；看门狗据此区分“模型在做事”和“执行器挂起”。 */
export class ProgressTracker {
  private readonly at = new Map<string, number>()

  note(reqId: string): void {
    this.at.set(reqId, Date.now())
  }

  last(reqId: string): number {
    return this.at.get(reqId) ?? 0
  }
}
