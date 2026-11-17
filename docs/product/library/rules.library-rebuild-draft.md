<!-- library
{
  "id": "rules.library-rebuild-draft",
  "title": "需求库重建只写入草稿",
  "status": "confirmed",
  "topics": [
    "library.rebuild",
    "library.draft"
  ],
  "summary": "需求库重建是按项目文档、验收用例、Git 与源码分批提炼并经已有库审查后，只把 draft 写入需求库的动作；不产生 confirmed，不覆盖人工条目或已确认规则，运行中可取消，已发布条目不回滚。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 需求库重建只写入草稿

## 业务目标
扩展产品知识沉淀而不擅自把推断变成已确认结论

## 用户与角色
- 所有者
- 产品 Agent
- 运行时重建流程

## 触发与前提
所有者在产品页发起重建需求库

## 预期行为
分批提炼候选，经已有库审查后写入 draft；报告与发布清单落在项目记录目录，发布前核对文件摘要并原子写入。

## 业务规则
- 重建只写 draft
- confirmed 与人工修改只记冲突
- 报告与发布清单落在项目记录目录
- 发布前核对文件摘要并原子写入

## 例外与边界
- 运行中可取消
- 已发布条目不回滚

## 可观察验收
- 重建结束后需求库新增条目状态为 draft
- 已 confirmed 条目内容保持不变

## 适用范围与版本
项目需求库重建，2026-11 版本

## 证据
- [doc] CONTEXT.md · 工作对象／需求库重建 · 2026-11-17
- [doc] docs/development/architecture.md · §4.1 ForgeLoop 业务会话（重建需求库） · 2026-11-17
