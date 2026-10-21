# ADR 0006：固定启动器托管的受控热升级

- **状态**：**已接受**（所有者 2026-10-21 交付实施方案并要求按 T0–T5 实施）；**仓库内实现进行中**，真机接入与验收另需授权
- **日期**：2026-10-21（Asia/Shanghai）
- **依据**：[热升级实施方案](../hot-upgrade-implementation-plan.md)、[ADR 0004 本机 CD](0004-local-cd-auto-deploy.md)、[常驻服务验收方案](../resident-service-acceptance.md)
- **基线**：实施前核对为 `e69a117`（与方案记录一致）；本 ADR 只记录方向性决定，不表示宿主接入或真机验收已完成

## 背景与现状

现有常驻服务的 unit 直接执行 `<prefix>/current/bin/forgeloop serve`。`current` 是符号链接，业务版本切换必须让 systemd 重新执行
`ExecStart`：要么 `systemctl restart`，要么在下次重启后生效。两者都不是“受控升级”：

- 重启由 systemd 发起，进程收到 SIGTERM 后最多等 `TimeoutStopSec`；`worker.stop(timeout)` 返回不代表在途调用已经完成。
- 页面推进请求只存在进程内存（`ServiceWorker._pending`），重启即丢失，但接口已经返回 202“已受理”。
- 既有健康检查是 `serve --once --json`。新版本若输出空内容，会被当成“不适用”并通过；`--help` 也不是运行版本证明。
- 既有 `deploy` 先安装、激活 `current`，再做健康检查；失败时只提示手工恢复入口，且 CLI 本身不负责停止/启动常驻进程。
- 受控路径已具备发布回执、每版本部署批准、产物 SHA256 与部署日志，但没有“已运行版本”的身份事实，无法回答“`current` 指向 A、实际运行的是不是 A”。

## 决定

ForgeLoop 自身后台程序采用**固定启动器 + 独立业务进程**的受控升级：

1. systemd 只托管一个**固定启动器** `forgeloop-launcher`，安装在 `<prefix>/launcher/.venv` 的独立环境中；普通业务版本升级不改写该环境、不改写 unit、不调用 systemd。
2. 启动器从 `releases/<version>` 的绝对路径启动业务进程，独占写 `<prefix>/control/upgrade-state.json` 与 `upgrade-events.jsonl`；业务进程只读取准入状态，不写升级现场。
3. 升级请求只能经本机运行账户可访问的 Unix socket 提交，首版只有 `status` 与 `switch/apply`。请求只含版本、产物身份、项目/前缀绑定与已有批准引用，不接受任意命令、路径或环境变量。
4. 启动器自行核对发布回执、每版本部署批准、项目/前缀绑定、标签提交与产物 SHA256；`by`/`reason` 只是审计字段，不是认证或批准凭证。缺任一项即拒绝，旧进程继续。
5. 切换按 `prepared → draining → starting → probing → committed` 推进；排空超时进入 `deferred`（旧进程继续，不扣研发失败额度），新版失败且确认退出后回到 `rolled_back`，回退也失败进入 `recovery_required` 并停止自动推进。
6. 排空以**真实排空报告**为依据：worker、面板轮次、Agent/测试子进程、HTTP 写入口都关闭新动作，等在途调用与会话轮结束并落盘；`stop(timeout)` 的返回不当作排空证明。
7. 已受理的推进请求写进项目库并幂等去重，入口先持久化再返回 202；换代后只消费一次，不复制任务状态，也不建立第二套队列状态。
8. 就绪必须核对新进程实际加载的版本、构建提交/产物身份、generation、项目与记录根，并要求模块加载路径位于候选安装目录；仅 `current` 指针、空输出或 `--help` 不能通过。
9. 托管前缀的 direct `deploy` 与 `bootstrap` 明确拒绝并给出 `forgeloop upgrade` 用法；既有非托管路径保持兼容。普通 `deploy` 不再作为托管实例的升级入口。
10. 代码回退不等于数据库回退：数据库不兼容或不可逆迁移不进入自动升级；本批不实现跨库分布式事务。

## 不做什么

- 不做跨项目聚合调度、零停机代理、监听 socket 接管或灰度/多实例；首版一个项目一个服务单元。
- 不做 Python `importlib.reload` 热替换业务模块；不改变 PI/DSH 的动作边界。
- 不自动发布、不自动批准、不自动做数据库迁移。
- 不把首次接入、启动器自身更新、不可逆迁移纳入“普通升级”；它们仍是维护操作。
- 不在本 ADR 授权 commit、push、生产升级、模型费用或宿主机写操作。

## 后果

- 升级失败时 systemd 单元和启动器 PID 不变；业务 PID、generation 与运行版本改变。
- 允许切换期间短暂 HTTP 断连；已受理请求在排空完成前不得丢失，任务只执行一次。
- 启动器自身异常退出后必须按现场对账，只恢复一个执行代；无法确认退出/提交的现场进入人工核对，绝不启动第二个可执行实例。
- 升级记录可回查：项目、前缀、请求 ID、批准引用、候选/上一版本、产物 SHA256、构建提交、generation、真实进程身份、阶段时间、排空/就绪/回退结论。

## 本机核对（2026-10-21）

- `HEAD = e69a117d064dffb2000c3bfa2caa28f539e4bb18`，与方案记录一致。
- 工作区存在其他会话的邮件在途改动（`cli/serve.py`、`cli/mail_interaction.py`、`domain/mail_interaction.py`、相关测试、新增 `cli/mail_worker.py` 与架构快照）；本批保留这些改动，不覆盖、不回退、不混入升级实现。
- 本机是 macOS（`Darwin 27.0.0 arm64`），**没有** `~/.local/share/forgeloop` 前缀，也**没有** `~/.config/systemd/user` 或 `forgeloop.service`；方案中记录的 Debian 宿主（`/home/link/...`）不在本机。记录根为 `.forgeloop/projects/forgeloop`，项目 `forgeloop` 已登记；`releases` 与 `deploy_approvals` 均为空。
- 因此本批只能交付仓库代码、测试、unit/安装脚本与操作文档；**真实宿主接入与“不重启 systemd 的 A→B 升级”未执行、未验收**。
