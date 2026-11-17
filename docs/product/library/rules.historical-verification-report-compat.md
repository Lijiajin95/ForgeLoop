<!-- library
{
  "id": "rules.historical-verification-report-compat",
  "title": "历史验证报告保持可读",
  "status": "confirmed",
  "topics": [
    "verification.report",
    "compatibility.history",
    "evidence.readability"
  ],
  "summary": "仅有结论、摘要、场景与阻塞项的历史验证报告应继续可读：缺失的新增可选字段按缺省补齐，未知的新字段被忽略而非拒绝，但自相矛盾的报告仍应被拒绝。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 历史验证报告保持可读

## 业务目标
在不影响新执行规则的前提下，让历史验证证据持续可读可引用。

## 用户与角色
- 验证执行者
- 需求负责人
- 审计与回溯人员

## 触发与前提
读取或校验早期生成的验证报告时。

## 预期行为
系统应兼容早期报告的字段结构，补齐缺失的可选字段并忽略未知新增字段；报告内部结论矛盾时仍判定为无效。

## 业务规则
- 历史通过报告在缺少新增可选字段时按缺省值补齐后仍可读取。
- 历史阻塞报告应保留其阻塞理由。
- 报告中出现未知的新字段时应忽略，不应因此拒绝报告。
- 历史报告若内部结论矛盾，仍应被拒绝。

## 例外与边界
- 结论与场景等内容自相矛盾的历史报告不因兼容策略而被接受。

## 可观察验收
- 用户可打开早期验证报告并看到完整结论与理由，读取过程不因字段缺失而失败。
- 对矛盾的历史报告，用户可观察到其被明确拒绝。

## 适用范围与版本
验证报告读取与历史证据回溯，2026-11 版本

## 证据
- [git] 0022eb94d13bf608a1c1478c89713e36033dd405 · docs/status.md · 2026-11-10
- [git] 60c27fa2f46b21684cb7dba06a5a9571d7cc876b · packages/forgeloop/tests/verification-report-compat.test.ts · 2026-11-10
