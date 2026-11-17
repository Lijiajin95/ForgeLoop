<!-- library
{
  "id": "rules.library-rebuild-evidence-sources",
  "title": "重建证据的多源采集与有界材料",
  "status": "confirmed",
  "topics": [
    "library.rebuild",
    "evidence.source",
    "evidence.limit",
    "credential.filter"
  ],
  "summary": "重建只读采集项目文档、验收用例、Git 提交与源码作为证据；文档排除需求库目录与依赖/构建目录，敏感凭据在进入模型前替换，材料受文件数、总字节与单文件大小上限约束。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 重建证据的多源采集与有界材料

## 业务目标
让重建基于真实项目证据，同时避免敏感信息外泄与超出处理边界

## 用户与角色
- 系统（采集与过滤）
- 项目所有者（受益方）

## 触发与前提
重建启动后进入取证阶段

## 预期行为
按文档、验收用例、Git 提交采集证据，文档与验收用例不足时用源码兜底；每条材料带来源、位置、时间与摘要，超出上限的截断或跳过。

## 业务规则
- 文档以章节标题作为定位信息
- 验收用例逐条提取标题，并带文件与行号
- Git 材料包含提交标识、日期、标题正文与变更路径
- 证据时间取对应路径最近一次提交日期，无 Git 时为空并排在最后
- api_key、token、私钥与 Bearer 凭据在进入模型前替换
- 材料受文件数、总字节与单文件大小上限约束

## 例外与边界
- 非 Git 仓库或无提交时按跳过原因报告
- 纯源码项目以源码兜底，不要求先有文档
- 单文件超过上限时跳过

## 可观察验收
- 重建报告可看到各来源的材料数量与跳过原因
- Git 材料带有可核对的提交标识与日期
- 送往模型的内容中不出现未替换的凭据

## 适用范围与版本
需求库重建的取证阶段，当前实现

## 证据
- [git] 584001186ca04263b3b122839fc1596a7a9533e3 · packages/forgeloop/src/runtime/library-extract.ts · 2026-11-16
- [git] 5c26dce2a34c1ac939949e565766d754bc54b082 · packages/forgeloop/src/domain/library-rebuild.ts · 2026-11-16

## 证据缺口与待澄清
- 纯源码项目的真实端到端效果仅有单元验证，尚未完整验证
