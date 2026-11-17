<!-- library
{
  "id": "intake.document-path-safety",
  "title": "需求文档路径必须限定在项目内且为 Markdown",
  "status": "confirmed",
  "topics": [
    "intake.document.path",
    "path.safety",
    "markdown",
    "symlink"
  ],
  "summary": "需求文档只接受项目内 Markdown 路径，符号链接按真实目标判断，真实目标不是 Markdown 时拒绝；项目内正常嵌套 Markdown 仍可读写。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 需求文档路径必须限定在项目内且为 Markdown

## 业务目标
防止需求文档入口读取项目外文件或非 Markdown 内容

## 用户与角色
- 需求提交人
- 项目所有者

## 触发与前提
需求提交人提交一个项目内文档路径

## 预期行为
系统解析路径及符号链接真实目标，仅当目标位于项目内且为 Markdown 时受理。

## 业务规则
- 文档路径必须位于项目内，并指向 Markdown 文件。
- 符号链接按其真实目标判断类型，真实目标不是 Markdown 时拒绝。
- 项目内正常嵌套的 Markdown 读取与写入不受限制。

## 例外与边界
- 路径越界、非 Markdown、文件缺失或超过大小上限均拒绝。

## 可观察验收
- 提交真实目标不是 Markdown 的符号链接会被拒绝。
- 提交项目内正常嵌套的 Markdown 可以成功受理。

## 适用范围与版本
通过文档提交发起需求的路径校验

## 证据
- [git] e75f928930744aacc2497bad5f806ce349ff5a78 · 路径越界与非 Markdown 由程序拒绝 · 2026-11-16
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts｜L106 · L106 · 2026-11-15
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts｜L117 · L117 · 2026-11-15
