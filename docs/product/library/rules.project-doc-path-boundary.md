<!-- library
{
  "id": "rules.project-doc-path-boundary",
  "title": "项目文档读写不得越出项目范围",
  "status": "confirmed",
  "topics": [
    "project.document",
    "path.boundary",
    "symlink.escape"
  ],
  "summary": "项目文档的读取与写入必须落在项目范围内，通过文件符号链接或其父目录链接逃逸到项目外的一律阻止，文件名为 Markdown 也不例外。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 项目文档读写不得越出项目范围

## 业务目标
防止项目文档操作被链接利用而读写项目外的内容。

## 用户与角色
- 读写项目文档的分析流程
- 项目所有者

## 触发与前提
读写路径解析到符号链接，或解析后的真实路径落在项目之外

## 预期行为
系统以解析后的真实路径判断是否仍在项目内，越界即阻止该次读取或写入；父目录为符号链接时同样判断。

## 业务规则
- 解析后的真实路径必须位于项目范围内
- 父目录为符号链接且指向项目外时也须阻止
- 不得以文件名为 Markdown 为由放宽路径校验

## 例外与边界
- 文件符号链接逃逸被阻止
- 父目录符号链接逃逸被阻止

## 可观察验收
- 指向项目外的文件链接无法被读取或写入
- 父目录链接指向项目外时，即使文件名为 .md 也被拒绝

## 适用范围与版本
项目文档读写，2026-11 版本

## 证据
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L82 · 2026-11-15
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L94 · 2026-11-15

## 证据缺口与待澄清
- 项目范围的最终判定基准（项目根或活动范围）在证据中未明确
