# 常驻服务与邮件入口的真实场景验收方案

本文只覆盖**必须在真实环境执行**的验收项——离线门槛（`make check`、`make test-system`、`make coverage`、`make frontend-e2e`、变异门禁）已由 CI/本地反复执行，不在本文重复。

约定：每条验收项写明**前提、命令、通过判据、证据留存**。任一判据不满足即**不通过**，如实记录，不放宽判据、不补造记录（项目纪律）。执行者列写明由所有者还是 Agent 执行。

## A. systemd 真机验收（所有者宿主，需 `systemctl --user`）

前提：宿主有用户 systemd 总线（所有者已确认 `systemctl --user` 可用）；常驻服务配置就绪（`config/service.toml` 或命令行给出 `--project`）；监听保持回环。

| # | 命令 | 通过判据 | 证据留存 |
| --- | --- | --- | --- |
| A1 | `forgeloop serve --print-unit > ~/.config/systemd/user/forgeloop.service`（或按 `docs/deployment.md` 安装） | unit 文件生成且 `systemd-analyze --user verify` 无错 | unit 文件内容 |
| A2 | `systemctl --user daemon-reload && systemctl --user enable --now forgeloop` | `systemctl --user is-active forgeloop` 输出 `active` | `systemctl --user status forgeloop` 全文 |
| A3 | `curl -s localhost:<port>/api/service \| head -c 400` | 返回 JSON，含服务状态、worker 心跳与「需人工核对」段 | 响应全文 |
| A4 | `journalctl --user -u forgeloop -n 50 --no-pager` | 启动核对记录可见（扫描到的未核对动作/残留槽位数量，可为 0） | 日志片段 |
| A5 | `systemctl --user restart forgeloop` | 30 秒内 `is-active` 回到 `active`，且 `/api/service` 可访问 | 前后两次状态 |
| A6 | `systemctl --user stop forgeloop` | 进程优雅退出（SIGTERM 路径），无强杀痕迹 | `journalctl` 尾部 |

**不通过时的处置**：A1/A2 失败多半是 unit 路径或环境变量（`WorkingDirectory`、`PATH` 需含 `.venv/bin`）；A3 失败先看日志里的监听地址是否被配置成非回环（非回环会被配置校验拒绝，属预期 fail-closed）。

## B. 重启恢复与不盲目重放（同上环境）

前提：至少有一个任务处于「执行中」现场（可用真实模型长跑 C 制造，或用既有 DogFood 任务）。

| # | 命令 | 通过判据 | 证据留存 |
| --- | --- | --- | --- |
| B1 | 在任务执行中 `kill -9 $(pgrep -f 'forgeloop serve')`，随即 `systemctl --user start forgeloop` | 服务自行恢复；`/api/service` 的「问题」段列出该任务的**未核对动作**（`outstanding_action`） | 问题段 JSON |
| B2 | 观察 5 分钟 | **不得**自动重放该动作；需求保持等待人工 | 需求状态与 reason |
| B3 | `forgeloop requirement actions list` → 人工核对后 `actions clear`，或 `requirement retry --node …` | 释放/续跑后任务继续，且不重复计入工时 | 动作记录与续跑决定 |
| B4 | 客户端断线场景：页面/`curl` 发起推进后立即断开连接 | 推进**照常完成**（202 受理交心跳执行），状态页可见结果 | 推进受理与最终状态 |

## C. 真实模型长跑（需所有者授权模型开销）

前提：一个**已批准**的任务包；`auto_advance = true`；PI 命令与 HOME 前提满足（worker 只读筛选会逐条给出不放行原因）。

| # | 步骤 | 通过判据 | 证据留存 |
| --- | --- | --- | --- |
| C1 | 打开 `auto_advance`，启动 serve，等待 ≥1 个完整任务周期 | 任务自动走完 `dev → review → test`，停在**验收门** | 状态页时间线、`task_runs` 记录 |
| C2 | 检查工时与失败轮次 | 工时累计与实际一致；失败轮次**不清零**、不虚增 | `status --json` 相关字段 |
| C3 | 中途 `systemctl --user restart` | 重启后**不重放**已完成的业务节点，只从现场继续 | 检查点 `next` 与动作记录 |
| C4 | 跑完一轮后核对副作用证据 | 候选 diff 身份（sha256）与工作副本存在性可在页面「问题」段或 `/api/service` 回查 | 证据字段 |
| C5 | 关闭 `auto_advance` | worker 只报告、不接续（页面/CLI 仍可人工推进） | 日志与状态 |

**不通过时的处置**：C1 不动先看 worker 的「不放行原因」（项目未配置、任务包未批准、PI HOME 与进程 HOME 不一致都会逐条给出）；C2 若计数错乱属**硬规则缺陷**，立即停止长跑并保留现场。

## D. 邮件入口真机验收（QQ 邮箱，已部分完成）

已完成（2026-10-18 实测）：真实 SMTP 发信被所有者确认收到；真实 IMAP 拉取 `fetched=12 registered=12 errors=0`；仅用 `--config` 即可运行。

| # | 步骤 | 通过判据 | 状态 |
| --- | --- | --- | --- |
| D1 | 从白名单地址发一封 `[ForgeLoop]` 邮件到 ForgeLoop 专用文件夹 | `mail poll --once` 登记成功并在权威记录里可回查 | ✅ 已验 |
| D2 | 同一封邮件再拉一次 | `Message-ID` 幂等：不重复建需求/不重复登记 | ✅ 已验（`registered` 不变） |
| D3 | 客户端把邮件标为已读后再拉 | 仍能拉到（不依赖 `UNSEEN`） | ✅ 已验（收件箱未读 0 仍成功） |
| D4 | `mail confirm` 回执 | 真实发出（`sent=true` + 真实 `Message-ID`）；**发送失败不得阻断需求流转** | ✅ 发信已验；失败不阻断待补反例测试 |
| D5 | 只放生产配置（`~/.config/forgeloop/mail.toml`）不带参数运行 | `mail poll --once --project ForgeLoop` 直接工作 | ⏳ 配置已就绪，待复跑确认 |
| D6 | 收件人被确认收到回信 | 所有者邮箱可见 | ✅ 已确认 |

## E. 未落实项（不得视为已验收）

1. `auto_analyze`：配置层已解析但**无消费点**，`true` 与 `false` 行为相同——需接线或从模板移除。
2. 副作用一致性：仅把证据交人工核对，**不自动判定**。
3. 页面无登录与多用户：单操作者回环设计（B01 触发条件未满足）。
4. 邮件轮询尚未纳入常驻 worker（当前由 cron 调 `mail poll --once`）。

## F. 判据汇总

| 组 | 通过条件 | 执行者 |
| --- | --- | --- |
| A | A1–A6 全部满足 | Agent（需宿主写权限）/ 所有者 |
| B | B1–B4 全部满足，且 B2 全程无自动重放 | 同上 |
| C | C1–C5 全部满足，C2 无计数错乱 | 所有者授权后由 Agent 执行或所有者执行 |
| D | D1–D6 全部满足（D4 的失败不阻断需补反例测试后确认） | 已完成，D5 待复跑 |
