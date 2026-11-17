<!-- library
{
  "id": "planning.project-agnostic",
  "title": "规划与方案不绑定特定技术栈布局",
  "status": "confirmed",
  "topics": [
    "planning.prompt",
    "project.facts",
    "tech.stack",
    "active.roots"
  ],
  "summary": "规划规则依据已知工程事实与活动工程根描述文件位置、测试命令与工程类型，不向非 ForgeLoop 项目施加 TypeScript 包布局约束。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 规划与方案不绑定特定技术栈布局

## 业务目标
让规划结果适配项目自身的工程事实，而不是套用某一项目的目录与技术栈假设

## 用户与角色
- 需求分析人员
- 方案设计人员
- 项目所有者

## 触发与前提
系统为某项目生成需求分析或技术方案规划

## 预期行为
系统根据已知工程事实与活动工程根描述文件示例、测试与架构文档位置、工程类型及正式测试命令。

## 业务规则
- 文件示例、测试与架构文档位置、活动工程类型与正式测试命令，均按已知工程事实与活动根表述。
- 不得写死特定项目的目录布局或技术栈。
- 非 ForgeLoop 项目不得收到 TypeScript 包布局约束。

## 例外与边界
- 工程事实缺失时，规划应表述为待确认，而不是套用默认布局。

## 可观察验收
- 对自定义工程事实生成规划时，不出现 ForgeLoop 或 TypeScript 的静态示例。
- 非 ForgeLoop 项目的规划结果不包含 TypeScript 包布局要求。

## 适用范围与版本
需求分析与技术方案生成；适用于所有接入项目

## 证据
- [git] cba0fe800aaf879d2f49e0f3f6cbca0d290b94af · 提示词去静态布局 · 2026-11-16
- [git] d3d141d0be4dd72a804c51a0a87915b6460b7105 · 规划规则按工程事实表述 · 2026-11-16

## 证据缺口与待澄清
- 工程事实缺失时的默认表述尚未给出明确规范。
