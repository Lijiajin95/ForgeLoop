<!-- library
{
  "id": "rules.installable-delivery",
  "title": "可安装交付要求六项材料齐备",
  "status": "confirmed",
  "topics": [
    "delivery.installable",
    "delivery.evidence"
  ],
  "summary": "可安装交付要求六项材料同时可用：受控提交、对应的候选构建包、安装说明、独立测试、业务验收、已核对试装，且试装包摘要等于交付包摘要，并记录可用时间；材料绑定旧需求版本或摘要不一致时判定不成立。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 可安装交付要求六项材料齐备

## 业务目标
把“测试通过”或“安装成功”与真正可安装、可核对的交付区分开

## 用户与角色
- 运行时交付判定
- 测试 Agent
- 运维 Agent
- 业务用户

## 触发与前提
准备把需求候选登记为可安装交付

## 预期行为
程序按记录事实逐项判定六项材料并核对试装包与交付包摘要，写安装说明并登记可用时间。

## 业务规则
- 六项材料缺一不可
- 试装包摘要必须等于交付包摘要
- 材料必须绑定当前需求版本

## 例外与边界
- 部署 intent 不能作为试装证据
- 记录层异常或试装未核对时判定不成立
- 材料绑定旧需求版本时不成立

## 可观察验收
- 可安装交付记录能列出六项材料与可用时间
- 摘要或版本不一致时交付不被判为可用

## 适用范围与版本
需求级交付判定，2026-11 版本

## 证据
- [doc] CONTEXT.md · 工作对象／可安装交付 · 2026-11-17
- [git] 25101e22025dc276a1b30afa00d49471a7d4439e · 提交说明（六项材料逐项缺失与不一致用例） · 2026-11-17
- [git] aac1c1e012dd52251acc4f3b0ac267bc54930486 · packages/forgeloop/src/domain/installable-delivery.ts, packages/forgeloop/src/records/installable-delivery-store.ts · 2026-11-16
