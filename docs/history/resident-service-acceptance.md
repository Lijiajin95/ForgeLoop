# 常驻服务与邮件入口的真实场景验收方案

本文只覆盖**必须在真实环境执行**的验收项——离线门槛（`make check`、`make test-system`、`make coverage`、`make frontend-e2e`、变异门禁）已由 CI/本地反复执行，不在本文重复。

约定：每条验收项写明**前提、命令、通过判据、证据留存**。任一判据不满足即**不通过**，如实记录，不放宽判据、不补造记录（项目纪律）。执行者列写明由所有者还是 Agent 执行。

## A. systemd 真机验收（所有者宿主，需 `systemctl --user`）

前提：宿主有用户 systemd 总线（所有者已确认 `systemctl --user` 可用）；常驻服务配置就绪（`config/service.toml` 或命令行给出 `--project`）；监听保持回环。

| # | 命令 | 通过判据 | 证据留存 |
| --- | --- | --- | --- |
| A1 | `scripts/install_local_service.sh --no-enable`（按 `docs/deployment.md`；首次接入是维护窗口） | 生成 unit、`control/owner.json` 与固定启动器环境；`systemd-analyze --user verify` 无错 | unit、owner.json 与脚本输出 |
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

## E. 受控热升级真机验收（固定启动器；普通升级不得 restart systemd）

前提：已完成一次性接入（A1，维护窗口允许重启）；存在一条已发布且**已获人工部署批准**的候选版本与一份可用产物；记录根、项目身份与 `control/owner.json` 一致。每步都留存命令输出、`upgrade-state.json`、`upgrade-events.jsonl`、`ready/drain-*.json` 与 `deployments.jsonl`。

| # | 步骤 | 通过判据 | 证据留存 |
| --- | --- | --- | --- |
| E1 | 首次接入后 `systemctl --user status forgeloop --no-pager` 与 `forgeloop upgrade status --prefix <prefix> --json` | unit `ExecStart` 指向 `launcher/.venv/bin/forgeloop-launcher`；systemd MainPID = 启动器 PID；业务进程 PID/generation 可见；`current` 与运行版本一致 | 两份输出 |
| E2 | 空闲 A→B：`deploy-approve` 后执行 `forgeloop upgrade apply --prefix <prefix> --tag vB --by <身份> --reason <理由>`；**不执行** systemctl | 启动器 PID/systemd MainPID 不变；业务 PID/generation 改变；`current`、运行版本与产物 SHA 均为 B；项目库记录仍在 | 前后状态、事件日志 |
| E3 | 有任务/会话在跑时发起升级 | 排空前不启动新动作；当前调用/会话轮完成后才切换；任务只执行一次；工时与失败累计不清零 | 状态与业务记录 |
| E4 | 构造排空超时（旧进程不写完成报告） | 状态 `deferred`；旧进程继续；无强杀、无指针切换、已受理请求不丢 | `deferred` 现场与旧 PID |
| E5 | 合法批准但候选启动失败/就绪超时 | 候选确认退出；从旧版本绝对路径恢复；`rolled_back` 记录两代身份；服务可用 | 两代身份与进程证据 |
| E6 | 回退也失败（旧版本被破坏） | `recovery_required`；停止自动推进；不启动第二个实例；保留证据等待人工 | 状态、日志与进程清单 |
| E7 | 缺批准/身份漂移/同版本异产物/篡改产物 | 请求拒绝；旧版继续；`current` 不变 | 拒绝原因与旧 PID |
| E8 | `kill -9` 启动器后重启 launcher | 按现场对账只接管一个已有执行代；不启动第二个业务进程 | 前后 PID 清单 |
| E9 | 数据兼容 | 新旧程序读取同一项目库有测试依据；不兼容候选在切换前拒绝；不把代码回退当数据回退 | 兼容性测试输出 |

**不通过时的处置**：E2 若 MainPID 改变，说明仍在走 systemd 重启路径，停止验收并核对 unit；E4 出现强杀或指针变化属硬规则缺陷；E6 不得继续自动重试，保留现场交人工。

## F. 未落实项（不得视为已验收）

1. `auto_analyze`：配置层已解析但**无消费点**，`true` 与 `false` 行为相同——需接线或从模板移除。
2. 副作用一致性：仅把证据交人工核对，**不自动判定**。
3. 页面无登录与多用户：单操作者回环设计（B01 触发条件未满足）。
4. 邮件轮询在 `serve --mail` 已接线，但真实邮箱长轮询未在固定启动器宿主上验收。
5. 受控热升级的**真机** A→B、排空超时、失败回退与 `recovery_required` 尚未在目标 Debian 宿主执行；仓库内只有真实子进程/替身协议证据。
6. 数据库兼容性目前是「同一项目库读取」测试与「不兼容拒绝自动升级」的设计约束，尚无自动迁移/版本协商机制。

## G. 判据汇总

| 组 | 通过条件 | 执行者 |
| --- | --- | --- |
| A | A1–A6 全部满足 | Agent（需宿主写权限）/ 所有者 |
| B | B1–B4 全部满足，且 B2 全程无自动重放 | 同上 |
| C | C1–C5 全部满足，C2 无计数错乱 | 所有者授权后由 Agent 执行或所有者执行 |
| D | D1–D6 全部满足（D4 的失败不阻断需补反例测试后确认） | 已完成，D5 待复跑 |
| E | E1–E9 全部满足，且 E2/E3 全程无 `systemctl restart`、无强杀在途任务 | 所有者授权宿主后执行 |
