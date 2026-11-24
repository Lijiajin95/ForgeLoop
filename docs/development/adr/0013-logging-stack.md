# ADR 0013：日志核心改用 pino，轮转用 pino-roll

- 状态：已接受（2026-11-24，所有者要求“推荐日志组件完成基础日志功能，非必要从头自研”）
- 相关：[架构说明 §5](../architecture.md)、[状态记录 §277](../../verification/status.md)

## 背景

`runtime/log.ts` 原本是手写的 JSON Lines 追加器：自己拼记录、自己按大小改名轮转、自己脱敏。
审查暴露四个问题：

1. 只记启动与协调器错误，业务阶段没有日志；没有 `debug` 级别，模型与命令交互无处可查。
2. 同一错误可连续写入 1095 行（861 KB），没有去重或限流。
3. 轮转只按大小改名，不按天、不压缩、不清理；旧版本留下的 text 行与 JSON 行混在同一文件。
4. 转录与证据文件不脱敏，凭据可能原样落盘。

自研这部分没有收益：结构化输出、级别、脱敏路径、轮转都是成熟库的既有能力。

## 决定

1. **核心用 `pino`**：JSON Lines、级别（含 `debug`）、`redact` 路径脱敏、序列化交给库。
   保留 `createPluginLogger`/`createHostLogger` 的调用接口，测试可注入 destination。
2. **轮转用 `pino-roll`**：按天生成 `plugin.<date>.<n>.log`，`logging.maxBytes` 仍限制单文件大小；
   读取端 `pluginLogPath`/`hostLogPath` 解析当前活动文件。
3. **压缩与保留自己做一层维护**：pino-roll 不做 gzip；`maintainLogFiles` 在启动与每 6 小时把
   当天之前的文件压成 `.log.gz`，并按 `logging.retentionDays`（默认 14）删除过期压缩文件。
4. **去重自研**：相同 warn/error 在 60 秒窗口折叠计数，窗口后首条带 `repeated`/`firstAt`/`lastAt`；
   键表上限 500，避免无界增长。
5. **统一 JSON**：删除 `logging.format` 与 text 分支，不再兼容旧格式的输出。
6. **脱敏边界**：Bearer、`sk-`、`api_key`/`token`/`secret`/`password` 在日志、Agent 转录、
   正式测试日志、候选构建日志、提交检查日志写入前统一替换为 `[REDACTED]`；
   提示词、模型输出与命令输出本身保留原文，用于审计与复现。

## 影响

- 新增运行时依赖 `pino@^10.4.0`、`pino-roll@^4.0.0`（安装包经 DSH 插件管理器安装，需能访问 npm registry）。
- 每个记录根一个 logger（`loggerFor` 缓存），生产模式经 pino transport 写盘，不再逐条同步写文件。
- 宿主 console 只回显 warn/error，info 只写文件。
- 读取端不再假设固定文件名 `plugin.log`；外部监控若写死该路径需要改为读取最新活动文件。
- 证据文件内容经过脱敏后再计算摘要，摘要与文件保持一致。

## 未采纳

- 继续自研：需要自己维护级别、脱敏和轮转，收益低。
- 只用 pino 不做轮转：文件无限增长，无法满足按天压缩。
- 用 pino-roll 的 `limit` 自动删除：它按文件数删除，无法保证先压缩再按天保留。
