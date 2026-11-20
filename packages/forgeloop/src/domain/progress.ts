export class ProgressTracker {
  private readonly at = new Map<string, number>()

  note(reqId: string): void {
    this.at.set(reqId, Date.now())
  }

  last(reqId: string): number {
    return this.at.get(reqId) ?? 0
  }
}
