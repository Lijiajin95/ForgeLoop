/**
 * 部署决定的身份校验：批准/拒绝/核对/回退只能由配置里的所有者发起。
 *
 * 模型工具没有这些入口；看板端点把认证会话映射为 config.owner 后调用服务，
 * 服务仍按确定性规则复核，不依赖页面或提示词。
 */

import { fail, type OperationResult } from './operation-result.js'

export function ownerOnly(owner: string, by: string): OperationResult | null {
  const actor = by.trim()
  if (!actor) return fail('forbidden', '部署决定缺少操作者')
  if (actor !== owner) return fail('forbidden', `只有所有者 ${owner} 可以执行部署决定`)
  return null
}
