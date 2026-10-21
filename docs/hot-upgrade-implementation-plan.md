# ForgeLoop 无需重启 systemd 的版本切换：实施方案与 DSH Prompt

日期：2026-10-21，Asia/Shanghai。核查基线：`e69a117`。

状态（2026-10-21 实施后）：**T0–T5 的仓库内实现与测试已落地**，启动器、部署拒绝、排空、切换/回退、安装脚本与 unit 均已改动；详见 [ADR 0006](adr/0006-supervised-hot-upgrade.md) 与 [状态记录](status.md)。**真机未接入、未验收**：本机是 macOS，无 Debian 部署前缀与用户 systemd；commit、push、生产升级与宿主写操作均未执行（需另行授权）。本文以下内容保留为方案与验收口径。

## 1. 目标、范围与验收口径

对 ForgeLoop 自身的后台程序实现受控升级：每次业务版本升级都不调用 `systemctl restart`、`daemon-reload`，不改写 unit；复用人工部署批准、产物校验和真实记录。systemd 持续托管固定启动器，启动器替换业务子进程并处理失败恢复。

首版保持以下范围：

- 每项目一个服务单元，内部为一个稳定启动器和至多一个获得执行权的业务进程；不扩大为跨项目聚合调度。
- 允许切换期间短暂 HTTP 断连；优先保证已受理请求不丢、任务不被强杀或盲目重放、失败可回退。零停机代理、监听 socket 接管留待实际需要。
- 升级以当前执行调用／会话轮次完整结束为安全点，不承诺现有代码尚未提供的任意节点无损暂停。
- 数据库变化必须经兼容性验证；不兼容或不可逆迁移拒绝自动升级，进入单独维护流程。
- 生产安装、首次 unit 接入、启动器自身升级、真实模型调用、commit 和 push 均不包含在普通仓库实施授权中。

用户级 systemd 管理本人服务通常无需 root。此前额外放行还涉及 Agent 工作区之外的部署目录与用户总线；本方案通过所有者一次性配置专用运行账户、目录权限与受控入口减少重复宿主操作，不取消权限控制或部署批准。

## 2. 当前实现与必须修复的缺口

| 位置 | 已核对的事实 | 本批处理目标 |
| --- | --- | --- |
| `scripts/install_local_service.sh` | 构建本地 wheel，以 `--bootstrap` 安装；已有同版本则沿用已激活产物；生成 unit 指向 `current/bin/forgeloop serve` | 首次接入固定启动器；托管后的普通升级走批准链，不能继续借 bootstrap 激活 |
| `adapter/deployment.py` | 独立版本环境、原子切换 `current`、日志；健康检查调用 `serve --once --json`，空输出也可能判不适用 | 分离候选准备、业务进程就绪与最终激活；就绪不能以空输出或 `--help` 代替 |
| `cli/deploy.py` | 正式路径检查发布和部署批准；bootstrap 跳过批准及服务健康检查；冒烟失败不自动回退；命令本身不重启 systemd | 托管前缀只能经启动器切换；所有切换失败都有明确、可核对的恢复结论 |
| `cli/serve.py` | `active_version` 读指针；HTTP 和 worker 同进程；退出时调用 worker 停止及面板关闭 | 报告进程实际加载身份；增加执行准入、排空与受托管模式 |
| `graph/worker.py` | `stop()` 限时 join 后返回；`_pending` 推进提示在内存 | 排空要证明执行结束；已返回受理的推进请求有持久依据 |
| `graph/session_runtime.py`、`graph/conversation.py` | 会话进程池与线程内状态需要显式关闭，冷启动回放能力有真实验证边界 | 等当前轮结束、保存记录后回收；不把进程仍存活解释为已完成切换 |

现有的 [部署批准决定](adr/0004-local-cd-auto-deploy.md)、[三入口等价约定](adr/0005-email-page-cli-parity.md)、[常驻验收方案](resident-service-acceptance.md)继续有效。PI/DSH 动作边界切换与 ForgeLoop 程序升级分别验收。

## 3. 最小设计

### 3.1 进程与安装布局

```text
systemd --user：一项目一个单元
  └── 固定环境中的 forgeloop-launcher
        └── releases/<version>/bin/forgeloop serve（指定项目与记录根）

<prefix>/
  launcher/.venv/                 固定启动器环境，普通升级不改写
  releases/<version>/            各业务版本独立环境与 artifact.json
  current                       已确认激活版本指针
  control/
    owner.json                  固定项目、登记根与允许前缀的绑定
    launcher.lock               单启动器／单次切换互斥
    upgrade.sock                本机受限控制接口
    upgrade-state.json          升级状态的权威现场，原子写入
    upgrade-events.jsonl        追加式升级审计
  deployments.jsonl              沿用现有部署回执
```

启动器可与 ForgeLoop 使用同一个 wheel 分发，但必须装入独立的固定环境，经独立入口 `forgeloop-launcher` 启动；普通版本升级不重装该环境，也不从可变的 `current` 导入启动器代码。不另外建设通用进程管理平台。

首次只管理一个明确项目与前缀。若发现多个服务共用同一前缀，拒绝自动升级并记录需要评审的拓扑冲突。启动器由所有者账户运行，不要求 root。

### 3.2 权威事实与小接口

- 业务、批准、失败累计和工时仍属于项目库，启动器不复制第二套任务状态。
- 启动器独占写升级现场和升级审计；业务进程只读取其执行准入状态。现场原子替换并按故障恢复需要 flush/fsync。
- 业务进程保留原有项目互斥；托管项目还需代际准入：只有已激活 generation 可以启动新的执行动作。排空期间所有入口服从同一规则，不能只拦 worker 而让 CLI、邮件或页面绕过。
- 本地控制接口首版仅支持 `status` 与 `switch`。`switch` 只接收版本、产物身份、项目身份和已有批准的引用；不接收任意命令、任意路径或任意环境变量。
- Unix socket 及控制目录限制访问权限，并校验调用身份。`by`、`reason` 是审计字段，不是认证或批准凭证。
- 启动器执行前自行核对权威发布回执、部署批准、项目／前缀绑定与产物 SHA256，不信任请求中的“已批准”布尔值。未知协议、缺失记录、读取异常、身份不符均拒绝。
- 首版新增 `forgeloop upgrade status|apply` 薄入口调用控制接口。普通 `deploy` 遇到托管前缀时必须明确拒绝并给出 upgrade 用法，防止直接改指针绕过排空；既有非托管路径保持兼容。

下载与安装到真实前缀也由启动器在验证批准后执行；CLI 只是客户端，不要求 Agent 直接写部署目录。下载来源绑定既有受管仓库的发布资产，不能由请求指定任意 URL。首次接入以外缺少发布回执时保持拒绝，不能自动改走 bootstrap。

固定启动器协议带版本号。将来批准记录或协议不兼容时先拒绝，启动器自身更新走低频维护，不承诺任意新协议永久可热升级。

### 3.3 升级状态流转

| 状态 | 允许的行为与退出条件 |
| --- | --- |
| `prepared` | 候选已安装但未激活；批准、产物、配置和兼容性预检通过；生产执行现场未改变 |
| `draining` | 拒绝启动新动作；已受理请求有持久依据；等待在途调用与会话轮次完成 |
| `deferred` | 排空超时或副作用不明确；取消本次切换，旧进程继续运行；不强杀、不扣研发失败额度 |
| `starting` | 旧业务进程已退出并确认资源关闭；从候选的绝对路径启动新进程，尚未授予执行权 |
| `probing` | 新进程只提供就绪／状态核验，不启动 Agent、正式测试或部署动作 |
| `committed` | 就绪通过，提交激活事实并授权新 generation；恢复处理持久化的待处理请求 |
| `rolled_back` | 新版失败且已退出；从旧版本绝对路径恢复，验证旧版可用并记录两代身份 |
| `recovery_required` | 回退也失败、现场损坏或无法确认副作用；保留证据，停止自动推进，要求人工核对 |

相同批准、版本及 SHA256 的重复请求应幂等回查，不再部署一次；同版本不同产物、并发切换、跨项目请求必须拒绝。提交激活事实之前重新核对批准与产物身份。

排空首版建议配置默认值为 300 秒，新版就绪与旧版恢复分别 30 秒；正式参数放配置和代码，验证类型及上下界，不写死在 AGENTS.md。排空超时只延期升级，不延长任务工时、不补造授权。

### 3.4 排空、请求与恢复

1. 现有 `_pending` 是调度提示。把需要跨切换保留的显式推进请求写入项目库后，入口才可返回已受理；提示引用原需求与批准，不复制任务状态。只读查询继续可用；无法持久接收的执行请求明确拒绝。
2. 增加独立的排空接口和可观察状态。当前 `stop()` 不充当排空证明；需要确认当前调度调用、面板轮次、Agent／测试子进程、HTTP 写请求和数据库连接均已完成或安全关闭。
3. 首版不强制截断长任务；仍有 `started` 未核对动作或子进程身份不明时，不进入切换。请求排空不等于任务已停止。
4. 暖会话在当前轮完成后保存可取得历史并关闭进程；换代后按已有冷启动规则恢复。不承诺内存上下文无损迁移或 DSH 跨进程会话恢复。
5. 新进程启动即固定 `running_version`、`build_commit`、`artifact_sha256`、`generation`、进程身份和项目身份。就绪检查还核对模块加载路径位于候选安装目录，避免误加载工作区或 PYTHONPATH 中的源码。
6. `current_version`、`running_version` 和候选版本分别报告，不能用指针冒充运行版本；空输出、错误 JSON、旧 generation 响应、错误项目或错误记录根均不能判就绪。
7. 启动器在关键副作用前后落盘状态。其自身异常退出后，启动时按现场对账，不仅靠 PID 数字认领进程；未知进程、未确认退出或不完整提交进入人工核对，绝不启动第二个可执行实例。
8. 本批不做跨库分布式事务。项目库中同一次请求的登记与去重使用事务；升级现场用互斥和可恢复的阶段记录。代码回退不等于数据库回退：新旧版本兼容性失败时不得自动切换。

### 3.5 权限与批准

首次由所有者配置固定启动器环境、专用控制目录与 unit；普通升级只通过受控接口处理已批准版本，不访问 systemd 总线，不反复写 unit。启动器、控制目录、部署前缀和批准库不得挂载给任务容器。

本方案只覆盖当前单所有者模型，不把文件分目录或 socket 权限描述为对同 UID 恶意进程的完整隔离。既有 host 执行模式的权限边界如实保留。

托管前缀的 bootstrap 仅供首次接入；已受托管后不能借 bootstrap 更新业务版本、跳过部署批准或跳过就绪检查。普通升级复用同一份已验收、已发布的产物，不在激活时重新构建。

## 4. DSH 执行任务与文件范围

以下为本方案后续实现的文件清单。每个任务必须包含“先失败的行为测试 → 最小实现 → 相关门禁”的完整闭环，不能把只交付红灯测试的任务当作已完成前置任务，阻塞下游实现。

**所有任务共同义务**：架构事实变化时，同批更新 `docs/architecture.md` 与 `contracts/architecture.json` 并运行 `make architecture-contract`；CLI／HTTP 输出变化时，同批更新 `scripts/export_cli_contract.py` 与 `contracts/cli-contract.json`。这些共享文件按集成顺序处理，不能末尾才补而让前置候选过不了门禁。

| 任务 | 实施内容与业务验收 | 准许修改／新增文件（除共同义务外） |
| --- | --- | --- |
| T0 基线与决定 | 核对 HEAD、在途改动、实际服务项目／前缀、现有批准与安装来源；列出差异；保存方向性决定；不动宿主 | 本文；`docs/adr/0006-supervised-hot-upgrade.md`（新增；如编号被占用，先报告，不覆盖） |
| T1 持久请求与执行准入 | 已受理推进请求持久化、重复请求幂等；所有执行入口在排空时不启动动作，旧版保持可查询；重建 worker 后仍能看到待处理请求 | `src/forgeloop/domain/upgrade.py`、`src/forgeloop/records/service_requests.py`（新增）；`src/forgeloop/cli/common.py`、`src/forgeloop/cli/main.py`、`src/forgeloop/cli/serve.py`、`src/forgeloop/graph/worker.py`、`src/forgeloop/graph/builder.py`、`src/forgeloop/graph/nodes.py`、`src/forgeloop/graph/planning.py`、`src/forgeloop/graph/agent_execution.py`；`tests/unit/test_service_requests.py`、`tests/property/test_upgrade_invariants.py`、`tests/component/test_upgrade_admission.py`（新增） |
| T2 排空与资源收口 | 等待真实调用／会话轮结束，关闭连接与子进程；超时延期升级，旧进程继续；未核对动作拒绝切换，不增加研发失败轮次 | `src/forgeloop/domain/upgrade.py`、`src/forgeloop/cli/serve.py`、`src/forgeloop/cli/panel.py`、`src/forgeloop/graph/worker.py`、`src/forgeloop/graph/conversation.py`、`src/forgeloop/graph/session_runtime.py`；`tests/unit/test_worker_drain.py`、`tests/integration/test_upgrade_drain.py`（新增） |
| T3 固定启动器与恢复现场 | 固定环境入口启动指定版本；单项目绑定、单启动器锁、控制协议校验、追加审计与异常重启对账；普通业务版本切换不替换启动器 | `src/forgeloop/cli/launcher.py`、`src/forgeloop/adapter/upgrade_control.py`、`src/forgeloop/records/upgrade_state.py`（新增）；`src/forgeloop/domain/upgrade.py`、`pyproject.toml`、`uv.lock`；`tests/unit/test_upgrade_state.py`、`tests/integration/test_upgrade_control.py`（新增） |
| T4 受控切换与回退 | 候选安装不激活；批准与产物复核；新代就绪后提交激活；失败恢复旧进程；回退失败明确停止；托管前缀 direct deploy／bootstrap 不能绕行 | `src/forgeloop/cli/upgrade.py`（新增）；`src/forgeloop/cli/main.py`、`src/forgeloop/cli/deploy.py`、`src/forgeloop/cli/serve.py`、`src/forgeloop/cli/launcher.py`、`src/forgeloop/adapter/deployment.py`、`src/forgeloop/adapter/upgrade_control.py`、`src/forgeloop/records/upgrade_state.py`、`src/forgeloop/domain/upgrade.py`、`config/quality-policy.toml`；`tests/scenario/test_supervised_upgrade.py`、`tests/scenario/test_supervised_upgrade_refusals.py`（新增） |
| T5 接入与机器验收 | 脚本准备固定环境及可审阅 unit；首次接入和普通升级分开；新旧版本启动与回退使用真实子进程，不调用系统总线；完成操作文档和待真机验收清单 | `scripts/install_local_service.sh`、`runtime/systemd/forgeloop-serve.service`、`config/service.toml`、`.github/workflows/deploy.yml`、`Makefile`、`docs/deployment.md`、`docs/resident-service-acceptance.md`、`docs/status.md`；`tests/system/test_supervised_upgrade.py`（新增）、`tests/system/test_systemd_unit.py`、`tests/scenario/test_deployment.py`、`tests/scenario/test_deployment_refusals.py` |

顺序为 T0 → T1 → T2 → T3 → T4 → T5，保持每步可验证。复用现有依赖并优先使用标准库，不为本批升级语言／运行时版本。业务状态与副作用接口优先于前端按钮；本批不改前端、邮箱交互语义、模型配置或提交策略。现有邮箱在途改动不能被混入本批。

若必须修改范围外文件，先说明必要性、精确路径和影响，再按项目约定评审。不能自行扩大白名单、放宽测试、增加未需要的队列服务或通用插件框架来取得通过。

## 5. 测试矩阵与退出条件

| 场景 | 必须得到的可观察结果 |
| --- | --- |
| 空闲升级 A → B | 启动器 PID／systemd 单元不变；业务 PID 与 generation 改变；运行版本确为 B；业务记录保留 |
| 有任务／会话在运行 | 排空前不启动新动作；等当前调用完成并保存；任务只执行一次，工时与失败累计不清零 |
| 排空超时 | 旧版继续，状态 `deferred`；没有强杀、没有切指针、没有丢受理请求 |
| 切换期间推进请求 | 受理前已持久化；恢复后只消费一次；没有批准时仍不执行 |
| 缺批准／身份漂移 | 未批准、不同项目／前缀、同版本异产物、产物与发布回执不符均拒绝，旧版继续 |
| 控制接口滥用 | 非法协议、路径穿越、任意命令／环境变量、无认证请求均拒绝，零安装／切换副作用 |
| 新版启动失败／就绪超时 | 候选退出得到确认，旧版从绝对路径恢复；当前指针与实际运行身份一致；失败原因可回查 |
| 假就绪 | `--help`、空输出、旧版端口响应、错误 generation／项目／模块来源均不被接受 |
| 回退失败 | `recovery_required`，停止自动推进并保留两版身份、进程证据和失败记录 |
| 启动器中途退出 | 按各阶段分别注入故障；重启只恢复一个执行代，无法确认的场景等待人工，不盲目重放 |
| 并发／重复升级 | 相同请求幂等；不同并发请求确定性拒绝；不能通过两个记录根或项目别名绕过前缀锁 |
| 数据兼容 | 新旧程序读取同一项目库有测试依据；不兼容候选在切换前拒绝；不可逆迁移不作自动回滚承诺 |

仓库内验证至少包括：

```bash
make check
make coverage
make test-system
.venv/bin/pytest tests/integration/test_upgrade_drain.py tests/integration/test_upgrade_control.py -q
.venv/bin/pytest tests/scenario/test_supervised_upgrade.py tests/scenario/test_supervised_upgrade_refusals.py -q
.venv/bin/pytest tests/system/test_supervised_upgrade.py -q
make test-install
make architecture-contract-check cli-contract-check
```

新增核心规则在 `tests/property/test_upgrade_invariants.py` 补属性验证；利用 `pyproject.toml` 的现有变异配置验证 `domain/upgrade.py` 的关键判定。`config/quality-policy.toml` 只允许登记逐项核验的等价／非行为幸存者依据，不降低阈值、不批量豁免、不排除关键行为；需要范围外测试文件时先评审。真实模型用例需单独授权，普通恢复测试不消耗模型。

测试允许使用独立临时项目、协议替身和故障注入，但必须运行真实业务接口、子进程、数据库与文件操作；不能直接伪造生产批准／验收事实，也不能把替身通过标成真实模型验收。

真机验收分两步，均先准备可审阅结果，再取得对应宿主授权：

1. **一次性接入**：展示将写入的固定启动器路径、unit、目录权限与回退命令；所有者确认后才安装和启动。该步允许维护窗口，不属于“普通升级无需 systemd”。
2. **普通升级**：在同一真实单元下从 A 升 B，记录 systemd MainPID、启动器 PID、业务 PID／generation、版本／SHA、项目身份、受理请求与任务结果；确认没有 systemctl 或 unit 写操作。再用合法授权的失败候选验证恢复 A。未执行就写“待真机验收”。

完成声明必须区分：配置完成、代码检查通过、真实子进程验证、真机 unit 不重启验证、真实模型业务验证。首次接入、启动器自身更新和不可逆迁移仍属于维护操作。

## 6. 交付与审计

- 每个任务报告：计划范围、实际改动、红→绿证据、真实执行命令及退出码、未验证事项、“发现但不碰”。不要以文件数量或进程退出 0 代替业务验收。
- 升级记录至少关联：项目、前缀、升级请求 ID、批准引用、候选／上一版本、产物 SHA256、构建提交、generation、真实进程身份、阶段时间、排空／就绪／回退结果。
- 仓库代码与宿主安装分开交付；本机配置、凭据、socket、状态文件、轨迹和数据库不入库。不能通过关闭 Hook、修改时钟或改写失败记录取得通过。
- 本文不更改 [架构说明](architecture.md) 中的“已实现事实”；各实现任务按共同义务更新事实与机读契约。

## 7. 可直接交给 DSH 的 Prompt

```text
请在 ForgeLoop 仓库实现 docs/hot-upgrade-implementation-plan.md 的方案。

目标：对已批准的 ForgeLoop 业务版本做受控切换；普通升级期间 systemd 单元和固定启动器保持运行，旧业务进程安全排空后由新进程接替，失败能恢复旧版。首版允许短暂 HTTP 断连，保持一个项目一个服务单元。

开始前读取 AGENTS.md、CONTRIBUTING.md、docs/development-discipline.md、docs/architecture.md、docs/adr/0004-local-cd-auto-deploy.md 与上述方案。核对当前 HEAD、实际模块接口、在途改动和项目／部署前缀，不假设文档基线 e69a117 仍是最新。保留其他会话工作，尤其邮箱相关在途改动。

本 Prompt 交付给你后，可按方案第 4 节实施仓库内代码与测试，不要只返回泛泛建议，也不要反复请求已覆盖的一般实施确认。按 T0→T5 推进，每个任务完成先失败的行为测试、实现、验证的完整闭环，不把预期失败的红灯测试单独当成交付前置。只有确实需要扩大文件范围时，提交必要性、精确路径和影响供评审。

必须落实到代码的约束：
1. 固定启动器使用独立环境和入口，普通版本不能覆盖或重载它；不使用 Python importlib.reload 热替换业务模块。
2. 启动器独立核对已有发布回执、每版本部署批准、项目／前缀绑定和产物 SHA256；by/reason 不能充当认证或批准。控制接口不接受任意命令、任意路径或环境变量。
3. 托管前缀的 direct deploy／bootstrap 必须拒绝绕行。未获授权的候选不能安装激活。
4. 已受理推进请求必须持久化；worker、CLI、邮件、页面、面板和 Agent 调用服从同一代际执行准入。排空超时延期升级，旧版继续；不能把 stop(timeout) 返回当成已排空。
5. 不强杀在途研发动作；等当前调用／会话轮完成并保存记录。新旧代不能同时推进同一项目。未知副作用保留现场等待核对，不自动重放。
6. 就绪必须核对新进程实际加载版本、构建提交／产物身份、generation、项目及记录根；仅 current 指针、--help 或空输出不能通过。
7. 新版失败要确认退出再恢复旧进程；回退失败进入 recovery_required 并停止自动推进。数据库迁移不兼容时拒绝自动升级，不把代码回退冒充数据回退。
8. 保留原有批准、失败累计、工时、停止与审计语义，切换不能清零。所有硬规则有通过与拒绝两侧的测试。

按方案同步架构文档、机读架构契约与 CLI／HTTP 契约。不要通过降低覆盖率、扩大等价变异登记、跳过关键测试或放宽路径校验过门禁。

先完成仓库内实现和真实子进程的切换／失败恢复测试，运行方案第 5 节要求的检查。若有环境失败如实分类，不把缺依赖或权限错误当作目标行为的红灯证据。

本 Prompt 不授权 commit、push、生产升级、模型费用、修改 systemd 或写真实部署前缀。宿主接入需要时，先提供具体 unit、目录／权限、安装动作及回退方案，取得对应授权后再执行；已明确取得的同项授权不重复索要。模型替身测试与真实模型验收分开报告。

最终交付：逐任务完成情况、修改文件、验证及未验证结果、升级协议与状态说明、首次接入操作单、真实验收清单、发现但不碰。不要声称本文方案或配置已等于热升级真实验收完成。
```

## 8. 参考依据

- [当前部署实现](../src/forgeloop/cli/deploy.py)、[安装与激活边界](../src/forgeloop/adapter/deployment.py)、[常驻入口](../src/forgeloop/cli/serve.py)、[worker](../src/forgeloop/graph/worker.py)。
- [Python exec 进程替换语义](https://docs.python.org/3/library/os.html#os.execv)：可保持 PID，但替换后的失败恢复需要额外机制，本方案选择固定启动器保留恢复控制权。
- [Python reload 限制](https://docs.python.org/3/library/importlib.html#importlib.reload)：线程安全与既有对象引用不自动更新，不能作为本项目的业务版本升级协议。
- [systemctl 用户级管理](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)：区分用户级服务管理与 root 权限，以及 Agent 沙箱的宿主访问约束。
