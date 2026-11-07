/**
 * 动作“无心跳”的判定阈值：必须大于单回合上限，避免把长回合误判为挂起。
 * 默认 1 小时；配置了 maxTurnSeconds 时取“回合上限 + 5 分钟”。
 */
export function staleActionMs(maxTurnSeconds?: number | null): number {
  const turn = maxTurnSeconds ?? 0
  return turn > 0 ? (turn + 300) * 1000 : 3_600_000
}
