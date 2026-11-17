<!-- library
{
  "id": "rules.admission-human-source",
  "title": "仅可识别的人类来源可进入需求准入",
  "status": "confirmed",
  "topics": [
    "admission.source",
    "admission.trust",
    "requirement.intake"
  ],
  "summary": "需求准入只接受可识别为人类提交的来源；非人类来源一律拒绝，来源标识为空或仅有空前缀时也不得视为可信。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 仅可识别的人类来源可进入需求准入

## 业务目标
防止非人类或身份不明的输入进入需求库，保证需求来源可追溯。

## 用户与角色
- 需求提交者
- 项目所有者
- 准入流程

## 触发与前提
提交需求或申请进入需求分析时

## 预期行为
系统校验来源身份，仅放行可信的人类来源；来源标识为空或仅有空前缀时拒绝准入。

## 业务规则
- 只有人类来源可被准入
- 空来源或仅有空前缀不得作为可信身份
- 拒绝时须说明来源不可信

## 例外与边界
- 非人类来源
- 来源标识为空
- 只有空前缀而没有可识别来源

## 可观察验收
- 非人类来源或仅有空前缀的需求被拒绝，并显示来源不可信的具体原因。

## 适用范围与版本
需求准入阶段，适用范围待确认

## 证据
- [acceptance] packages/forgeloop/tests/admission.test.ts · L102 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L215 · 2026-11-09

## 证据缺口与待澄清
- “可信人类来源”的具体身份判定口径待确认
