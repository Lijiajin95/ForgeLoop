<!-- library
{
  "id": "ops.logging.secret-redaction",
  "title": "日志写入前脱敏敏感值",
  "status": "confirmed",
  "topics": [
    "logging.security",
    "logging.redaction",
    "logging.validation"
  ],
  "summary": "写入运行日志前，对 Bearer、sk-、api_key、token、secret、password 等敏感值脱敏，避免密钥与口令以原文落盘。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 日志写入前脱敏敏感值

## 业务目标
防止运行日志泄露凭证

## 用户与角色
- 运维人员
- 安全负责人
- 插件运行时

## 触发与前提
日志写入包含敏感模式的值时

## 预期行为
系统在写入前识别并脱敏指定敏感模式；日志配置在装载期校验；脱敏后的日志仍保留可定位问题的上下文。

## 业务规则
- 敏感值不得以原文写入运行日志。
- 脱敏发生在写入前，而不是读取时。
- 日志配置在装载期校验，非法配置应被拒绝。

## 例外与边界
- 无法识别的密钥形态可能不被脱敏。
- 脱敏不得破坏请求与动作的关联标识。

## 可观察验收
- 检索运行日志时看不到 Bearer、sk-、api_key、token、secret、password 的原文值。
- 含敏感值的失败场景仍可通过关联标识定位。

## 适用范围与版本
ForgeLoop 插件运行日志，2026-11 版本

## 证据
- [git] 555992826cf782353127b0d1a0ef90006498b4a0 · 提交说明 P2 · 2026-11-12

## 证据缺口与待澄清
- 脱敏规则是否覆盖自由文本中的其他凭证形态待确认。
