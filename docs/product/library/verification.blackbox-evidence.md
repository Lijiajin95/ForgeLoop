<!-- library
{
  "id": "verification.blackbox-evidence",
  "title": "独立验证采用黑盒证据",
  "status": "confirmed",
  "topics": [
    "verification.blackbox",
    "verification.evidence",
    "verification.fail-closed",
    "verification.repair"
  ],
  "summary": "显式独立验证只允许测试会话提交验证材料，验证命令由程序在固定候选上执行，声明必须与真实输出一致，否则阻断。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 独立验证采用黑盒证据

## 业务目标
让独立验证结论可复核，避免测试会话读取源码或自证

## 用户与角色
- 研发人员
- 独立验证会话
- 业务复审

## 触发与前提
显式 verify 被触发时

## 预期行为
系统把已交付候选固定下来，启动受限测试会话，仅允许写验证材料；测试会话无 shell、不得读取源码或候选差异；命令由程序执行并核对输出；证据必须匹配真实输出，否则阻断；可修复阻断交回研发。

## 业务规则
- 测试会话只能提交验证材料，不能执行命令或改写候选。
- 验证会话不得读取源码或候选差异。
- 验证结论必须引用程序执行命令产生的真实输出，声明本身不算证据。
- 证据与真实输出不符时必须阻断。
- 会话无法打开时必须失败关闭，不得跳过验证。

## 例外与边界
- 可修复的阻断应带修复建议回到研发。
- 不可修复的阻断应终止本轮交付。
- 非显式 verify 路径的迁移范围待确认。

## 可观察验收
- 独立验证记录中可核对命令输出片段与结论的对应关系。
- 测试会话只能写验证材料；声明与实际输出不符时验证不通过。
- 测试会话无法打开时验证被阻断而非放行。

## 适用范围与版本
显式 verify（独立验证阶段），2026-11 版本

## 证据
- [git] 262dd325427defed564f22c6fac962442dab773c · 提交说明；src/runtime/prompts.ts、verification-pipeline.ts · 2026-11-11
- [git] 5f448479c743e30af0b6e2002af58ace82bb480a · 提交说明；VerificationPipeline.executeVerificationBlackBox · 2026-11-11

## 证据缺口与待澄清
- 非显式 verify（advance）路径仍走旧流水线，迁移范围待确认。
- 验证材料的稳定输出判定标准待确认。
