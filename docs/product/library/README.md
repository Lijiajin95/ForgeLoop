# 需求库

本目录是产品级背景条目：产品目标、术语、已确认决策与指标口径。每个条目是 Markdown +
顶部 `<!-- library {...} -->` JSON 头，运行时扫描并建立索引；分析时注入 L0 索引，
需要正文时由产品 Agent 用 `forgeloop_read_library_entry` 按 id 读取。

- 本 README 没有条目头，扫描时会跳过（只留 warning）。
- `status` 只能是 `confirmed`、`draft`、`superseded`；只有 `confirmed` 可以作为
  “已有结论、禁止重复提问”的依据。
- `ref` 指向项目内既有 Markdown 时是引用条目，正文留在被引用文档，不复制。
- `topics` 是对齐澄清缺口用的稳定主题；同一主题已有 `confirmed` 条目时，新回答不会再提问。
- 所有者回答会由程序自动回写为 `decisions/` 下的 confirmed 条目；模型推断不得写成 confirmed。
