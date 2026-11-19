export function staleActionMs(maxTurnSeconds?: number | null): number {
  const turn = maxTurnSeconds ?? 0
  return turn > 0 ? (turn + 300) * 1000 : 3_600_000
}
