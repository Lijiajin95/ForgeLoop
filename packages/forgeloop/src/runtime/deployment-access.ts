import { fail, type OperationResult } from './operation-result.js'

export function ownerOnly(owner: string, by: string): OperationResult | null {
  const actor = by.trim()
  if (!actor) return fail('forbidden', '部署决定缺少操作者')
  if (actor !== owner) return fail('forbidden', `只有所有者 ${owner} 可以执行部署决定`)
  return null
}
