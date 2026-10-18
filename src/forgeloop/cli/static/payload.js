/**
 * `/api/progress` 的读模型类型与端点常量。
 *
 * 只声明页面真正读取的字段：服务端文档还有更多键（方案、证据、依赖等），
 * 页面不读就不在这里建模，避免把「没读过的东西」伪装成契约。字段名与
 * `contracts/cli-contract.json` 的 `web_progress_document` 一致。
 */
/** 只读进展接口路径（服务端路由 `cli/web.py` 的 `_route`）。 */
export const PROGRESS_URL = "/api/progress";
/** 只读进展接口之外的写入口：提交需求与单需求动作（服务端 `cli/serve.py`）。 */
export const REQUIREMENTS_URL = "/api/requirements";
/** 页面令牌：服务端注入 `<meta name="forgeloop-token">`，写请求放在请求头里。 */
export const TOKEN_META_NAME = "forgeloop-token";
export const TOKEN_HEADER = "X-Forgeloop-Token";
/**
 * 未经注入的令牌占位：`forgeloop web`（只读服务）不下发令牌，页面据此隐藏操作面板，
 * 而不是拿着占位串去发一个必然被拒的请求。
 */
export const TOKEN_PLACEHOLDER = "__FORGELOOP_TOKEN__";
/** 提交键在会话存储里的键名：刷新页面后仍复用同一个键，避免「刷新即重复提交」。 */
export const SUBMIT_KEY_STORAGE = "forgeloop:submit-key";
/** 单需求动作的写端点。 */
export function requirementActionUrl(reqId, action) {
    return `${REQUIREMENTS_URL}/${encodeURIComponent(reqId)}/${action}`;
}
