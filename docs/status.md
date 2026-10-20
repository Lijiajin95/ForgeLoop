# ForgeLoop 状态记录

本文件是 ForgeLoop **当前状态**的唯一记录入口。README 只描述稳定的产品范围与文档索引，不写当前状态；逐批次的实测过程、失败与门禁细节保留在[工程可靠性方案](engineering-reliability.md)第 13–21 节。

更新规则：实现批次、门槛数字、CI 与远程状态变化后更新本文件；只写实际执行的证据，未执行或未验证的事项如实标记（沿用历史记录时注明来源）。

## 1. 当前状态（需求修订截至 2026-10-15，Asia/Shanghai；历史验证按各批日期）

### 2026-10-15：自我迭代需求澄清与任务调整

所有者明确要求 ForgeLoop 具备修改自身项目并交付可验收代码的能力；撤销“只能由 ForgeLoop 提交”和服务端拒绝其他工具写入的要求，不将其移入待实现列表。所有者、DSH 及其他工具可按项目授权、提交时段和质量约定共同开发，实际执行来源如实记录。

- 任务计划：C04 已取消，G03 移除 C04 依赖，G04 改为“自我迭代持续使用验证”，依赖 G01 真实单任务验收；G02/G03 的完整业务、并行与恢复验收各自保留。新 G04 待对应方案批准，不以来源签名、专用写入身份或排他窗口作为通过条件。
- 停止与重新启动：旧 G04 如正在执行，应先请求停止、核实进程和副作用并保留记录，再核对新基线、任务包版本及范围，取得对应批准后开始。实际停止情况待执行方回执确认，本次文档修订不作为停止回执。
- 计划范围与实际改动：仅 `docs/product-requirements.md`、`docs/requirements-review.md`、`docs/dogfood-execution-plan.md`、`docs/dogfood-contracts.md`、`docs/branch-protection.md`、本文件；写入所有者决定、任务调整及清理边界，保留既有实现和验证记录。
- 配置状态：来源策略仍为 `enabled = false`；基本分支保护与现有提交纪律继续执行。本轮仅修改文档，未删除来源门禁代码、未修改 GitHub 配置、未创建 commit。
- 验证结果：`make check` exit 0，静态检查通过，1005 项通过、3 项真实模型用例未启用而跳过、5 项未选；原始日志 `/private/tmp/forgeloop-self-iteration-docs-check-20261015.log`。六份文档的 33 个本地 Markdown 文件链接均存在，`git diff --check` 通过；本次未执行真实自我迭代任务或启动新 G04。
- 并行工作边界：检查期间另一执行方暂存了 `adapter/git_workspace.py`、`graph/builder.py`、`graph/nodes.py`、`graph/requirements.py` 及两份需求执行测试的改动，本轮未修改、暂存或回退这些文件；上述检查覆盖当时的混合工作区，不能单独充当该执行方任务的验收结论。
- 已清理（2026-10-15，`b3827a7`）：`cli/merge.py` 的来源签名、`scripts/check_dogfood_provenance.py`、`config/dogfood-policy.toml`、`quality.yml` 的来源作业、相关测试和 `graph/builder.py` 的来源前缀说明均已删除（净删 948 行）；业务批准与交付材料绑定保留。原「发现但不碰」条目已闭环。

以下批次实现与验证沿用各自记录日期，不能据本次需求修订推定真实验收已经完成。

首版 CLI 闭环已实现并通过工程门槛，**尚未在真实任务上跑通**（见第 6 节缺口）。CD 的受控发布（S1）与受控部署（S2）已实现，本机已完成首次引导部署（独立版本目录 + 原子切换 + 部署回执）；S3 的合入门槛方案 B（候选分支流程）已实现。

2026-10-13 上午外部复核后修复两个影响验收的缺陷：**独立审查不再 fail-open**（结果缺失或非结构化时中断 `review_result_invalid`，交人工决定）、**发布→部署链路接通**（`release.yml` 显式 `workflow_dispatch` 派发 Deploy，因 `GITHUB_TOKEN` 创建的 Release 事件不触发下游工作流）；计划文档（首版需求／架构／RoadMap）同步为“主体已实现、真实验收未完成”。批次细节见[工程可靠性方案第 21 节](engineering-reliability.md)。

2026-10-13 下午（协调批次，未提交）：DogFood 计划启动——T00 基线与环境冻结（`.cache/dogfood/t00/baseline.md`）、T01 交接约定定稿（`docs/dogfood-contracts.md`）、G01 首个真实任务与 A01/C01 执行单就绪（`.cache/dogfood/lines/`）；B02 提示词契约补齐（开发提示携带批准测试命令与自验证要求、审查输出契约、失败回边证据）；假 PI 全链路演练通过（`.cache/dogfood/dryrun/evidence.md`：实现会话在副本内、审查会话在任务记录目录内、候选 diff 来自副本、源项目未改写）；架构门禁与变异工具链的集成缺口已修复并重导清单。 真实模型最小演练通过（32.3s 到 `awaiting_acceptance`，审查为合法结构化 `blocking_issues`，源项目未改写）；演练发现并修复真实运行缺口：**凡会继续执行图并启动 PI 的命令都必须在隔离 HOME 下运行**（第 22.2 节）。 验收→归并演练通过（临时项目：`delivered` → 归并提交 → 工作树干净）；直连流程（`--no-push/--direct-push`）不写 `merge-evidence.json` **属设计使然**（不安全遗留路径，现有用例显式断言），非缺口。

2026-10-13 晚（可靠性门槛精简，未提交）：按所有者要求把纯形式门槛降为可见提示，让真实任务不再被结构数字、同一 CI 作业内的重复执行或过期清单整理挡住——**结构数字（函数行数、文件长度、公开接口数、复杂度、参数数、分支数）改为审阅提示**（Ruff `C901`/`PLR0912`/`PLR0913` 与 Pylint 两项检查停用，数字统一由结构报告给出）、**变异过期已审条目改为提示**、**CI 改为 `make check-static coverage test-system`**（高频＋集成用例只在一次带覆盖采集中执行）、**CLI 状态读取失败报到 stderr**、**G01 前置条件收窄**（现有单任务链即可先验证，B03/A05/C01/B04 新增能力各自验收）。全部业务与正确性测试保留，配置损坏与源码解析失败仍失败，覆盖率门槛仍 90%。过程、红→绿证据与并发干扰记录见[工程可靠性方案第 25 节](engineering-reliability.md)。

2026-10-14（I01 三条业务线入口 + I02 契约同步，未提交）：I01 把需求线接到真实 CLI（`requirement submit|revise|analyze|plan|approve|advance|accept|status`），并在 `graph.builder.RequirementTaskRunner` 中把已批准任务映射到稳定身份的单任务记录，复用既有业务图；新增场景 `tests/scenario/test_full_development_flow.py` 与系统 `tests/system/test_requirement_process.py`（组合式假 PI + 真实检查点与测试命令，**不等于**真实模型闭环）。I02 同步架构描述、CLI 契约（新增 `requirement status --json` 快照）、产品需求/路线图、术语与操作说明，并核查质量门槛；**核查发现变异门槛为既有红点**（`domain/release.py` 两个函数无 unit/property 覆盖导致 63 个 no tests，`domain/merge.py` 新增 8 个未审阅幸存者），修复需补测试与审阅记录，属本任务范围外，按“发现但不碰”登记。验证数字见下，详见[可靠性方案第 26 节](engineering-reliability.md)。

2026-10-16/17（SAST 引擎替换，未提交）：**SAST 引擎由 semgrep 换为 Ruff S 子集 + 本地 AST 检查**。根因是 semgrep 最新版精确钉死 `mcp==1.29.0`（带 CVE-2026-59951）无法升级；替换后 **`mcp` 与 `semgrep` 已离开依赖树，依赖审计例外已移除**（`make audit` 不再传 `--ignore-vuln`）。Ruff 精确选取 7 条 bandit 代码（`S102`/`S301`/`S307`/`S501`/`S506`/`S602`/`S605`，不整体启用 `S`），`scripts/check_untrusted_deserialization.py` 唯一补上 `S506` 未覆盖的 `yaml.unsafe_load`（实测 `S506` 已覆盖 `Loader=yaml.Loader`/`UnsafeLoader`、无 `Loader` 的 `yaml.load` 及第二个位置参数传 Loader，本地检查对它们只作防御性重复）；原 `.semgrep.yml`、`scripts/run_semgrep.py` 与 `make sast` 目标已删除。`uv.lock` 包数由移除前 **151** 降至 **106**（净减 45；`semgrep 1.180.0` 自身声明 27 个直接依赖）。历史执行记录保留在可靠性方案第 13/14 节，替换事实与数量变化见[第 27 节](engineering-reliability.md)。

2026-10-17（B01 只读状态页 `forgeloop web`，未提交）：按所有者选择实现待实现列表 B01 的**只读部分**——在浏览器里查看需求／任务／问题处理进展，刷新配置项默认每 1 分钟。页面上的操作入口（批准／推进／验收）与多人设备访问**仍未实现**，仍在 B01 的触发条件下等待。

- 计划范围：新增 `src/forgeloop/domain/progress.py`（刷新间隔与问题分类纯规则）、`src/forgeloop/cli/web.py`（只读 HTTP 服务与读模型）、`src/forgeloop/cli/web_page.html`（静态页面）、`config/web.toml`（刷新配置项）与七份分层测试；修改 `cli/main.py`（注册 `web` 命令并注入文档构建器）、`records/store.py`／`records/requirements.py`（跨项目只读清单）、`scripts/export_cli_contract.py`（进展文档进入契约快照）、`docs/architecture.md`、`docs/engineering-reliability.md`、`docs/pending-requirements.md`、`README.md`、本文件与两份契约快照。
- 实际行为：`forgeloop web [--host 127.0.0.1] [--port 8710] [--refresh-seconds N] [--web-config config/web.toml] [--records-root .forgeloop]`；`GET /` 返回随包分发的静态页面，`GET /api/progress` 由权威记录生成需求／任务／问题三段与生效刷新配置，只接受 `GET`/`HEAD`（其余方法 405 且不写记录），未知路径 404，读取失败返回 500 并把原因写 stderr（不伪装成「没有记录」）。
- 刷新配置项：`config/web.toml` 的 `refresh_seconds` 默认 **60 秒**（每 1 分钟），`--refresh-seconds` 覆盖，`0` 表示关闭自动刷新；非法值（负数、非整数、布尔）启动即失败，不静默回落。
- 问题口径（`domain.progress` 纯规则）：任务「需要人工介入」的阻断／中断／等待追加授权／工时耗尽／待确认停止、需求阻断，以及未完成执行槽位；等待批准、等待验收、等待澄清等正常流程门**不算问题**，未知状态不猜测。
- 验证结果：`make check` **exit 0**（1427 项通过、3 项真实模型用例未启用跳过、5 项未选；Pyright 0 errors＋1 条既有 warning；架构与 CLI 契约门禁通过，结构报告 0 失败）。`make test-system` **19 项通过**（含 6 项 `web` 真实子进程用例：真实监听、真实 HTTP、刷新覆盖、端口占用与非法配置的确定性失败）。`tests/integration -m "not install"` **133 项通过、5 项 pi_live 跳过**（含 20 项 `web` 真实回环端口用例：只读、405／404、真实记录生成三段、HTTP/1.0 响应后关连接）。本次新增测试 **106 项**（unit 70、component 10、integration 20、system 6）。另核验真实 wheel：`forgeloop/cli/web_page.html` 在构建产物内（`uv build` 产物 63 条 entry，含该文件）。原始日志：`/tmp/forgeloop-b01-check.log`（make check）、`/tmp/forgeloop-b01-system.log`、`/tmp/forgeloop-b01-integration.log`。
- 一次失败与归因（如实记录）：最终校验期间误并发启动了两次 `make check`，负载下 `tests/property/test_slot_residue.py::test_cleanup_only_clears_dead` 以 Hypothesis 截止时间判 flaky 失败一次（首次 393.55ms > 200ms 截止，重试 12.06ms）；单跑该文件 5 项通过，去掉并发后重跑 `make check` **exit 0**（1427 项通过）。该项与本次改动无关（未触及槽位残留与 SQLite 并发路径），归因于本机并发负载；**原始失败日志已被随后那次干净运行的日志覆盖**（两者写入同一路径），此处只保留失败签名与数字，未以复跑替换失败记录。
- 页面脚本的真实执行证据与据此发现的缺陷：`tests/component/test_web_page_runtime.py` 用最小 DOM 替身在 node 里执行页面脚本（node 只当解释器，无 npm／无构建；无 node 时跳过）。**首次执行即发现真实缺陷**：渲染函数参数名为 `document`，遮蔽全局 `document`，页面在浏览器里会完全空白，而 Lint、Pyright、字段契约测试全部为绿。修复为 `render(progress)` 后 5 项运行时用例通过；把缺陷注入回去复跑，5 项全部失败（红→绿证据成立）。
- 未验证（如实记录）：页面**仍未在真实浏览器中运行**——上面用的是最小 DOM 替身，不是真浏览器，因此 CSS 布局、暗色主题、倒计时与手动刷新按钮的实际观感、以及跨浏览器行为均未经核对，请所有者打开 `http://127.0.0.1:8710/` 核对。`--host` 绑定非回环地址未实测（默认只监听回环）。页面未做任何写操作（只读），也未做多人访问与鉴权。
- 架构同步：`cli.web` 为 `cli` 层新模块、`domain.progress` 为 `domain` 层新模块，跨层边未新增（`contracts/architecture.json` 仅多两条 `modules` 条目，`layer_edges` 不变）；`docs/architecture.md` 第 1、3、6、7 节同批更新（第 2 节的分层表与允许依赖方向不变，`layer_edges` 无新增条目）。两模块之间与 `cli.main` 之间**无 import 环**：需求／任务两份查询文档的构建器由 `cli.main` 以 `ProgressDocuments` 注入，架构契约的环检查首次运行即拒绝了「`cli.web` 反向导入 `cli.main`＋延迟导入」的写法，改为注入后通过。
- 契约：`GET /api/progress` 的结构进入 `contracts/cli-contract.json`（`web_progress_document`）；数组元素位置用 `$ref` 指向同一文件里已合并的 `requirement_document`／`document`，避免同一份结构在快照里重复出现（首次导出曾重复 1372 行，已改为引用）。
- 发现但不碰：① `src/forgeloop/cli/main.py` 已有 **1062** 物理行（超过审阅例外上限 1000，本批 +10 行），建议后续把 CLI 只读查询文档拆出独立模块；② `build_progress_document` 触发结构报告审阅提示（64 行、复杂度 11），判断为线性装配、拆函数反而更难读，按纪律不为数字拆改；③ 第 1 节「外部系统共 N 类」原列表漏了既有真实边界「IMAP/SMTP 邮箱服务」，本次因同一句必须改写（加入 HTTP 边界）而一并补全并改为八类，属同一句内的事实订正，特此披露。

2026-10-17（前端工具链：TypeScript 适配的 lint 与编码风格规则，未提交）：按所有者要求，参考 Python 侧的 lint／编码风格规则补一套 TypeScript 适配规则，并按可靠性方案第 1 节预留的触发条件（出现前端界面与真实浏览器需求）正式接入前端工具链。**触发背景**：同日 B01 只读状态页落地后，页面行为代码此前是 HTML 内联 JS，不受任何静态门禁覆盖。

- 计划范围：新增 `frontend/`（TypeScript 源、ESLint／Prettier／tsc／dependency-cruiser／knip／Vitest／Playwright／Stryker 配置、`package.json` 与锁文件）、`src/forgeloop/cli/static/*.js`（编译产物）、`scripts/check_frontend_build.py`／`check_frontend_policy.py`／`check_frontend_mutation.py`、`frontend/tests/**`、`tests/fixtures/seed_web_e2e.py`、`tests/unit/test_frontend_gates.py`；修改 `src/forgeloop/cli/web.py`（按名分发页面模块）、`src/forgeloop/cli/web_page.html`（去掉内联脚本）、`Makefile`、两份 CI 工作流、`.pre-commit-config.yaml`、`.gitignore`、`config/quality-policy.toml`（新增 `[frontend]`）、`scripts/check_structure_metrics.py`（前端一节的报告口径）、`CONTRIBUTING.md`、`README.md`、`docs/architecture.md`、`docs/engineering-reliability.md`（新增第 28 节）、`docs/pending-requirements.md`、本文件。
- 规则对应（数值同源于 `config/quality-policy.toml`）：Ruff＋Pyright → ESLint（`typescript-eslint` 类型化推荐集）＋tsc strict 合并选项；Ruff S 子集 → 禁 `eval`／`new Function`／`innerHTML` 注入；Ruff format 100 → Prettier 100；import-linter → dependency-cruiser（无环＋三条分层规则）；deptry → knip；覆盖率 90% → Vitest（v8）；mutmut → Stryker；pip-audit → npm audit；结构数字（函数 50／文件 500／复杂度 10／嵌套 4／参数 5／语句 50）→ ESLint 同值规则，**同为审阅提示（warn），不阻断**。
- 运行方式：`make frontend-check`（格式、ESLint、tsc、产物漂移、策略同源、边界、knip、jsdom 用例）已进 `make check`；`make frontend-e2e`（真实 Chromium + 真实 `forgeloop web` 进程）进 CI 推送路径；`make frontend-mutation`（Stryker）进夜间作业（03:00 Asia/Shanghai，与 Python 变异同节奏）；`make frontend-audit` 进安全作业；改了 `frontend/src` 必须 `make frontend-build` 写回随包产物，否则漂移门禁拒绝。
- 验证结果（本机 macOS ARM64，Node 26.11.1、npm 11.20.0）：`make check` **exit 0**（**1461** 项 Python 通过、3 跳过、5 未选；前端 **68** 项 jsdom 用例通过；Pyright 0 errors＋1 既有 warning；架构与 CLI 契约门禁通过；结构报告 0 失败）。`make frontend-coverage` exit 0：语句/行/函数 **100%**、分支 **98.82%**（门槛各 90%）。`make frontend-e2e` exit 0：**4 项真实浏览器用例**通过（记录→服务端→编译产物→DOM、刷新说明与倒计时、立即刷新、纯文本渲染）。`make test-system` **20 项**通过；`tests/integration` **139 项**通过、5 项 pi_live 跳过。真实 wheel 含 `forgeloop/cli/static/*.js` 六个模块与页面 HTML（69 条 entry）。
- 变异实测与两处真实发现：Stryker 首次实跑（**213** 个变异体、24 秒）击杀率 **68.08%**，据此补测试后达 **95.77%**（`format.ts` 97.73%、`progress.ts` 92.59%；检出 204、未检出 9、no coverage 0），9 个幸存者逐项审阅后**全部判为等价变异**并登记在 `[[frontend.reviewed_survivors]]`，未登记幸存者会让 `scripts/check_frontend_mutation.py` 失败。① **变异测试抓出「同义反复」断言**：缺值标记与多数字典标签原先断言的是被测文件导出的同一常量／只覆盖了两类标签，时间戳只断言「与原文不同」；这些断言对变异完全不敏感，已改为钉字面量与形状。② **工具版本实测决策**：`@stryker-mutator/vitest-runner@10` 与 vitest 5 不兼容——vitest 5 下击杀率只有 **3.29%**，且每个「幸存者」的 `testsCompleted` 都是 0（根本没跑测试），属**假幸存**；降到 vitest `^4.1.11` 后同一份代码得到 95.77% 的真实结果。本次选择保留可用的变异门禁而非最新主版本，升级前必须复跑并确认 `testsCompleted` 非零。
- 代价与限制（如实记录）：① 引入 **Node 26 与 npm registry** 依赖（`package-lock.json` 锁定，`npm ci` 安装；Chromium 由 Playwright 下载到 `.cache/ms-playwright`，本机实测 572 MB），`make setup` 现在同时准备两侧工具链；② `npm audit --audit-level=high` 当前报 **2 个 moderate**（`@stryker-mutator/core → typed-rest-client → qs`，全部在开发期变异工具链，不进入随包页面与 wheel），high 及以上为空，结果如实保留在安全作业输出；③ 结构数字的分级口径不同：Python 报告有 hint(40)/review(50) 两级，ESLint 只能给一个 `warn`，前端取复核阈值 50；④ 变异范围不含 `render.ts`（DOM 管线等价变异多、收益低），与 Python 只变异核心领域规则同口径；⑤ 前端工具链未接入 axe 可访问性扫描与 Vitest 浏览器模式。
- 发现但不碰：① 页面**操作入口**（批准／推进／验收）仍未实现，仍在 B01 触发条件下等待，且必须复用 CLI 的批准绑定与幂等校验；② `frontend/package.json` 的依赖树里 `qs`（经 `typed-rest-client`）有 moderate 通告，上游未修，未用 `overrides` 强行改版本；③ `docs/quality-assurance-plan.md` 的 Q 线批次未包含前端工具链，其「有效数值以 `config/quality-policy.toml` 与可靠性方案为准」的表述已足以覆盖本次接入，故未改动该文件。

2026-10-18（取消 GitHub 账号 Signing Key 要求，未提交）：按所有者决定，**取消“必须在 GitHub 账号登记 SSH 公钥为 Signing Key”的要求**——账号级签名密钥登记不再作为本项目的要求、准入条件或验收前提。本机 SSH 签名（`gpg.format=ssh`、`user.signingkey=~/.ssh/id_ed25519.pub`、`commit.gpgsign=true`）与规则集 `main-protection` 的 `required_signatures` **全部保留**，未撤销；账号侧现有登记保持现状，本次不删除。

- 计划范围与实际改动：仅 `docs/branch-protection.md` 与本文件；**未修改 GitHub 规则集、未改本机 git 配置、未删除账号密钥、未创建 commit**。
- 事实核对（2026-10-18）：规则集 `main-protection`（id 25133735，active）规则为 `deletion` + `non_fast_forward` + `required_signatures`，bypass=所有者（mode=always）；`origin/main` 最新提交 `28c403b` 的 GitHub API 校验为 `verified=true, reason=valid`（账号侧当前存在可验证该签名的登记）；本机仓库配置含 `gpg.format=ssh`、`user.signingkey=~/.ssh/id_ed25519.pub`、`commit.gpgsign=true`。
- 已记录后果（据 GitHub 文档，**未实测删除登记后的推送行为**）：GitHub 只把能对账号内已登记公钥验证成功的提交标为 Verified；账号侧无对应登记时，新推送的提交显示 Unverified，而 `required_signatures` 阻止的是**未签名或未验证**的提交。所有者 bypass=always，本机提交与推送不受影响；无 bypass 权限的推送者会被该规则阻断。已验签提交的验证记录在仓库网络内持久保留，不因登记后续变化被改写。
- 验证结果：`make check` **exit 0**（Python **1464 项通过**、3 项真实模型用例未启用跳过、5 项未选；Pyright 0 errors＋1 条既有 warning；CLI 契约快照与架构契约一致；结构报告 0 失败 / 308 条审阅提示；前端 5 个文件 **68 项通过**）。两份改动文档的本地 Markdown 链接均存在（`branch-protection.md` 3 条、本文件 26 条），`git diff --check` 通过。原始日志：`/tmp/forgeloop-signingkey-check.log`。
- 环境修复（如实记录，非本次需求改动）：首次 `make check` 在本机 **exit 2**，失败于 `lint`——`.venv/bin/python` 指向旧 checkout 路径（`/Users/lijiajin/Project/projects/history_projects/ForgeLoop/.toolchain/…`，仓库迁移后已不存在）。按 `make setup` 的 uv 命令重建 `.venv`（`uv sync --frozen`，Python 3.13.15；`uv.lock` 与受版本控制文件均未改动）后复跑通过。
- 发现但不碰：① 仓库本地 git 配置的 `gpg.ssh.allowedsignersfile` 仍指向已不存在的旧 checkout 路径（随 2026-10-15 来源门禁清理失效），使 `git log --show-signature` 报 `No principal matched`；建议后续 `git config --unset gpg.ssh.allowedsignersfile`，本次未改本机配置。② 本文件第 4 节 CI 条目仍写“分支保护……**未设置**”，与第 6 节 ruleset 已设置（2026-10-16 核对）矛盾，属范围外旧文，本次未改。③ `docs/branch-protection.md` 第 6 节原写“来源签名清理尚未实施”，与 `b3827a7` 的实际删除不符；本次因同属“已取消签名要求”一并按仓库现状订正，特此披露。

2026-10-18（R1 常驻骨架 `forgeloop serve`，未提交）：按所有者「产物应该是程序，可以后台常驻」的要求与已评审的[常驻服务与页面操作入口方案](resident-service-plan.md)实施第一批 R1——**建立常驻载体，但不执行任何任务**（`execution_enabled = false` 如实出现在状态文档里，不靠文档声称）。

- 计划范围：方案 §7 R1 列出的文件（`src/forgeloop/domain/service.py`、`src/forgeloop/graph/worker.py`、`src/forgeloop/cli/serve.py`、`config/service.toml`、`runtime/systemd/forgeloop-serve.service`、三层测试），并同步 `src/forgeloop/cli/main.py`、`scripts/export_cli_contract.py`、两份契约快照、`docs/architecture.md`、`docs/deployment.md`、`README.md` 与本文件。范围外未改代码。
- 实际行为：`forgeloop serve [--host] [--port 8712] [--service-config config/service.toml] [--web-config] [--refresh-seconds] [--once] [--json] [--records-root]`；`/`、`/api/progress` 与静态模块复用 `cli.web` 的读模型与请求处理器，新增 `GET /api/service`（worker 状态、生效配置、与进展文档**同源**的「需人工核对」清单）；HTTP 在后台线程运行、主线程等 `SIGTERM`／`SIGINT` 后优雅停止（退出码 0）；`--once` 只做配置与前提校验并打印状态（不监听端口）。
- 失败关闭（全部实测拒绝启动，退出码 1 并把配置文件路径写进原因）：非回环 host、端口越界、`poll_seconds < 1`、用布尔冒充整数、未知配置键、`schema_version` 不符、TOML 解析失败、项目档案缺字段、PI 隔离 HOME 缺 `.pi/agent/models.json` 或该文件为空。
- 验证结果：`make check` **exit 0**（Python **1563 项通过**、3 项真实模型用例未启用跳过、5 项未选；Pyright 0 errors＋1 条既有 warning；CLI 契约与架构契约门禁通过；结构报告无失败；前端 5 个文件 **68 项通过**）。本批新增测试 **57 项**（unit 36、integration 8、system 13）：真实回环端口路由与 405／404、被拒绝的写请求不产生任何任务／槽位／动作、真实子进程 `--once` 自检不监听、心跳计数可见、`SIGTERM` 退出码 0 且端口释放、六类非法配置拒绝启动。原始日志：`.cache/r1-check.log`。
- 架构同步：三个新模块都在既有层内（`domain.service`、`graph.worker`、`cli.serve`），`contracts/architecture.json` 的 `layer_edges` 无新增；`docs/architecture.md` 第 1／3／7 节同批更新（模块清单、常驻服务段落、外部边界由八类改九类并加入 systemd／journal）。`GET /api/service` 与 `serve --once --json` 结构进 `contracts/cli-contract.json`，其中 `counts` 与 `review_required` 元素用 `$ref` 指向既有 `web_progress_document`，不重复抄结构。**不新增任何表**，worker 在 R1 不写记录。
- 未验证（如实记录）：① **systemd 安装、开机自启、`Restart=on-failure` 与 journal 日志未验收**——本机运行在 bwrap 沙箱（pid 1 = bwrap，无用户 systemd bus），`systemctl --user` 无法连接；unit 模板与安装步骤已交付（`runtime/systemd/forgeloop-serve.service`、`docs/deployment.md`），需在真实宿主手工验收；② 异步执行与唤醒（R2）、页面操作入口（R3）、重启核对（R4）**未实现**，方案 §12 的六项待所有者决定；③ 常驻进程与 `records.sqlite` 的并发（WAL／`busy_timeout`）未实测。
- 发现但不碰：① 本文件 `S1 真实发布`／CI 表的「无标签」表述仍与真实 `v0.0.1` 标签及 GitHub Release 矛盾，`已安装 CLI 版本` 也与本机实机不符（上一轮已报告，本次未改）；② 邮件线有一条 owner 已批准的需求 `req-20261016021551-ed498a`（邮件通知核心 v6）卡在 `plan_approval_stale`（已知缺陷 #24），本文件也一直没有邮件批次记录——两者都属邮件线，本次未处理。**2026-10-18 只读诊断（补充事实）**：`.cache/dogfood/selfiter-records` 共 45 个任务，其中 13 个检查点落有不可归因的陈旧 `halted_reason`（`halted_node` 为空，按现规则 `retry` **fail-closed** 永久等待）：**11 个状态已是 `merged`**（历史现场，无影响）、1 个是本条邮件任务（`blocked`）、1 个是 `req-20261016191752-229835-v6-t1-pin-regression`（`time_exhausted`，走追加授权而不是续跑）。也就是说该缺陷当前真实影响面只有这一个可执行任务；`plan_approval_stale` 在当前源码里已无产生点，属迁移前旧现场残留。解卡路径（未执行）：按既有语义追加需求版本重建任务包，或改代码允许人工决定显式指定重入节点。

2026-10-18（缺陷 #24 修复：无法归因的陈旧中断改为人工点名重入节点，未提交）：按所有者决定「先修缺陷 #24 再解卡邮件需求」实施。

- 问题（只读诊断实测）：迁移前的检查点可能落有**无法归因**的 `halted_reason`（例如旧代码产生的 `plan_approval_stale`），此时 `halted_node` 为空；旧规则下 `requirement retry` 对该现场**永远 fail-closed**，任务永久停在 `blocked`／`awaiting_user`。`.cache/dogfood/selfiter-records` 的 45 个任务中有 13 个此类现场，其中 **11 个状态已是 `merged`**（历史现场，无影响），真实受影响的是邮件任务 `mail-ports`（`blocked`）与 `229835` 的 `time_exhausted`（后者走追加授权，不属于本缺陷）。
- 修复（**不放宽既有红线**）：`requirement retry` 新增 `--node dev|review|test`，**只**用于检查点自身无法归因的中断——必须点名、必须是可续跑业务节点、可归因时不得改指其他节点、没有 `halted_reason` 时不得指定；点名的节点随决定落库（新列 `resume_node`，旧库读取按缺列处理），清除 `halted_reason` 时据此补齐重入点。**未点名仍然 fail-closed**；未完成动作（`started`）仍禁止重放；可归因现场的原有行为不变。
- 计划范围：`src/forgeloop/records/checkpoints.py`、`src/forgeloop/cli/requirements.py`、`tests/unit/test_requirement_retry_records.py`、`tests/unit/test_requirement_retry_resume.py`、`tests/component/test_requirement_retry_cli.py`、`docs/architecture.md` 与本文件；未改检查点库与既有记录。
- 红→绿证据：先写并运行失败用例（records 层 6 条、graph 层改写 1 条＋新增 1 条、组件层 2 条），实现后全部通过；组件层用真实业务图 + 假 PI 验证「旧现场无 `--node` 被拒且不进图」「`--node dev` 后就地续跑并继续 review/test」。
- 验证结果：`make check` **exit 0**（Python **1572 项通过**、3 项真实模型用例未启用跳过、5 项未选；Pyright 0 errors＋1 条既有 warning；CLI 契约与架构契约门禁通过；结构报告 0 失败；前端 **68 项通过**）。本批净增 9 项测试；原始日志 `.cache/defect24-check2.log`。
- 未执行：邮件需求的 `retry --node dev` 续跑本身**尚未运行**（真实模型、长跑），待所有者确认人工理由文本后按隔离 HOME 入口启动。

2026-10-18（R2 常驻自动接续与唤醒，未提交）：按方案 §7 R2 实施——常驻 worker 从「只打点」升级为「只读筛选 + 开关打开时自动接续」，两个后台验收项（决定后唤醒、客户端断开后推进）已用真实子进程实测。

- 计划范围：`src/forgeloop/graph/worker.py`、`src/forgeloop/cli/serve.py`、`config/service.toml`、`runtime/systemd/forgeloop-serve.service`、四层测试（`tests/unit/test_worker_scheduling.py`、`tests/property/test_worker_idempotent.py`、`tests/integration/test_worker_execution.py`、`tests/system/test_serve_async.py`），并同步 `scripts/export_cli_contract.py`、两份契约快照、`docs/architecture.md`、`docs/deployment.md`、`README.md` 与本文件。
- 实际行为：worker 每个心跳先做**只读筛选**（项目已在 `config/service.toml` 配置、任务包已批准、下一步主体是 agent、PI HOME 与进程 HOME 一致），逐条给出不放行原因；`auto_advance`（默认 **false**）打开后把筛选结果交给既有 `RequirementDispatcher`／`RequirementExecutor` 执行——并发上限、同需求互斥、同项目交付串行、停止请求与失败累计全部复用既有实现，**不新建队列、不新建状态表**；关闭时只报告。`serve --once` 也做一次只读筛选，自检输出候选/跳过数量；`GET /api/service` 新增 `projects`、`executable_projects` 与 `worker.last_tick`（候选、执行、跳过原因、结果摘要，均为**对象数组**以便契约快照记录元素类型）。
- 顺带修复 R1 的一个真实缺陷：PI 隔离 HOME 的判据路径写成 `.pi/models.json`，与真实布局 `.pi/agent/models.json` 不符，会把合法 HOME 误判为不可用而拒绝启动；已改为真实路径，并同步测试、`config/service.toml` 注释与文档。
- 验证结果（定向实测）：与本功能相关的 **84 项** 测试全部通过（unit／property／integration／system 四个层次，含真实子进程与真实业务图 + 假 PI）。其中 R2 新增 **30 项**（unit 16、property 4、integration 4、system 2，另含 R1 用例按 R2 语义更新）。**完整 `make check` 待真实模型长跑结束后再跑**（避免与在跑的真实任务争用资源，届时补记数字）。
- 后台验收（方案 §8 R2）：① **决定后唤醒**：需求先处于未批准、常驻进程空闲，由**另一个进程**执行 `requirement approve` 后不再有任何推进调用，worker 在若干 `poll_seconds` 内自行开始执行（系统用例实测）；② **客户端断开后推进**：批准之后测试不再访问服务，只读 SQLite 记录判定，任务自行跑到 `awaiting_acceptance`（`dev`／`review`／`test` 三个动作完成）；③ 反向用例：`auto_advance=false` 时即使已批准也**不执行**；④ 重启恢复与副作用核对属 R4，**未实现**。
- 未验证（如实记录）：① 真实模型下的常驻长跑未执行（本批系统用例用假 PI，只证明编排）；② systemd 真机验收仍未执行（沙箱内无用户 systemd bus）；③ `auto_advance=true` 下的多需求并发上限与同项目交付串行只由既有 dispatcher 用例覆盖，未在常驻进程内单独压测。

2026-10-18（邮件线：缺陷 #24 修复后真实续跑，`mail-ports` 到达验收门）：按所有者确认的理由执行 `requirement retry --node dev` 解卡并续跑，全程真实模型。

- 执行轨迹（真实记录）：人工决定落库（`resume_node=dev`，绑定检查点与 `plan_version=6`）→ `dev`（第 19:40–19:45）→ `review`（阻断后自动回边）→ `dev` 第二轮（19:48–19:54）→ `review` 第二轮 → `test`。
- **真实发现（缺陷级环境缺口，已修）**：`test` 节点首次以 `FileNotFoundError: 'uv'` 失败——任务包里的 `test_command` 是快照（`uv run pytest …`），而运行环境 PATH 里没有 `uv`。现场是干净的（检查点停在 `test`、无 `halted_reason`、无未完成动作、无残留槽位），补上 PATH 后 `requirement advance` 正常续跑，测试 **exit_code 0**（2 秒内跑完计划里的四个测试文件）。修复：协调侧 `.cache/dogfood/fl-debian.sh` 把仓库 `.venv/bin` 加进 PATH；`runtime/systemd/forgeloop-serve.service` 与 `docs/deployment.md` 增加「测试命令所需工具必须在 PATH 里」这一前提与实例配置。
- 产出（候选 diff，新增 1767 行）：`src/forgeloop/mail/{__init__,config,ports,presets,render,secret}.py`、`tests/unit/test_mail_{ports,config_resolution,secret_status}.py`、`tests/property/test_mail_render.py`、`config/mail.example.toml`，并同步 `docs/architecture.md` 与 `contracts/architecture.json`。独立审查结论 `blocking_issues=[]`（审查方在候选工作区实测 `make check` 1216 通过）。
- 现状与待办：任务停在 `awaiting_acceptance`，需求 `executing`「等待决定: task-…-v6-mail-ports」——**等待所有者对单任务的人工验收**；验收后需求线才会继续推进剩余三个任务（`mail-smtp-send`／`mail-imap-receive`／`mail-governance`）。未完成动作与槽位均为空，无需人工核对清理。

2026-10-18（R3 页面操作入口，未提交）：按方案 §7 R3 实施——页面从只读升级为「只读 + 五类人工操作」，写请求与服务端判定分离。

- 计划范围：`src/forgeloop/cli/serve.py`、`src/forgeloop/cli/web_page.html`、`frontend/src/{actions,payload,render,page}.ts`、`frontend/.dependency-cruiser.cjs`、编译产物 `src/forgeloop/cli/static/actions.js`、四层测试，并同步 `scripts/export_cli_contract.py`、`contracts/cli-contract.json`、`docs/architecture.md`、`docs/deployment.md`、`README.md`、`tests/unit/test_web_page.py` 与本文件。
- 实际行为：`POST /api/requirements`（提交需求）与 `POST /api/requirements/{req_id}/approve|advance|accept|stop`。三道闸门：启动时随机生成的一次性页面令牌（`GET /` 注入 meta，`web` 只读服务不注入）、同源校验（`Origin`/`Referer` 的 authority 必须等于 `Host`）、请求体 ≤ 64 KiB。**批准/验收/停止调用 `cli.main` 注入的同一函数对象**（批准来源写 `web:<by>`，落同一张批准表），推进复用 worker 的筛选规则（批准绑定、停止、槽位、PI HOME 前提一条不放宽），提交写权威记录。页面新增操作面板（令牌缺失时隐藏），浏览器侧只做必填校验与结果展示。
- 契约：`contracts/cli-contract.json` 新增 `service_submit_route`、`service_action_routes`、`service_operation_document`、`service_operation_error_document`；`service_document` 新增 `operations_enabled`。
- 验证结果：`make check` **exit 0**（Python **1595 项通过**、3 项真实模型用例未启用跳过、5 项未选；Pyright 0 errors＋1 条既有 warning；CLI 契约与架构契约门禁通过；结构报告 0 失败；前端 7 个文件 **91 项通过**）。本批新增测试 **29 项**：集成 20（令牌/同源/体量/JSON/理由/未知路径/只读方法仍 405、提交写记录、批准与验收调用同一入口并带 `web:<by>` 来源、停止定位当前任务、推进拒绝、`operations_enabled`、页面带令牌、被拒写请求零业务事实）、系统 1（**真实进程全链路**：页面提交 → 页面批准 → 常驻进程自动推进到验收门 → 单任务人工验收 → 页面整体验收，4 秒跑完）、前端 unit 15＋component 8（真实页面 HTML + 注入写请求替身）、Python 页面契约 1。原始日志 `.cache/r3-check.log`。
- 后台验收（方案 §8 R3）：真实回环 HTTP 与真实记录下完成「页面提交 → 页面批准 → 自动推进 → 页面验收」；缺令牌、跨源、非 POST、缺理由一律拒绝且不产生记录；重复批准幂等沿用既有批准绑定。
- **订正（2026-10-18 审计）**：本条目原先笼统写「审计字段完整」，逐端点核对后**只部分成立**——只有需求级任务包批准落了操作人与来源（`requirement_plan_approvals.approved_by`／`source=web:<by>`）；任务级批准（`approvals`）、停止（`stops`）、提交与推进在权威记录里**没有 actor 列**，页面确实收下并校验了 `by`，但无处安放（不是被丢弃）。缺口与两个方案记在下面的「写操作审计缺口」条目，补列/补表属持久化变化，等所有者决定。
- 真实浏览器用例（**已完成**，2026-10-18 补）：`frontend/tests/e2e/operations.spec.ts` 用真实 Chromium 打开真实 `forgeloop serve`（`playwright.config.ts` 增加第二个 webServer，端口 8714 + 播种脚本 `tests/fixtures/seed_serve_operations_e2e.py`），在浏览器里完成「页面提交 → 页面批准 → 常驻进程自动推进到验收门 → 单任务人工验收（CLI 子进程扮演）→ 页面整体验收」，并断言权威记录变成 `accepted`；`make frontend-e2e` 5 项通过（7.1s）。
- **该用例当场抓出一个真实 UI 缺陷并已修复**：批准类响应同时带 `req_id` 与 `output`，页面 `successMessage` 先取 `req_id`，导致「任务包 v1 已批准…」被显示成「已受理：<需求身份>」——记录已批准而页面说已受理。已把顺序改为「先 `output`（CLI 自己的话），无 `output` 时才是提交类的已受理」，并补单元用例钉住。
- 未执行（如实记录）：① 页面没有登录与多用户（B01 触发条件未满足，监听保持回环）；② 页面提交的幂等**已按所有者 2026-10-18 决定补齐**（服务端 `client_key` 部分唯一索引 + 页面 `sessionStorage` 暂存，刷新后仍复用同一个键；新开浏览器/标签页视为新的提交意图，本来就是新的一次提交）。

2026-10-18（R4 重启恢复与副作用核对，未提交）：按方案 §7 R4 实施——常驻进程被强杀后**只报告、不重放**，恢复路径由人工经既有 CLI 入口完成。

- 计划范围：`src/forgeloop/graph/worker.py`、`src/forgeloop/cli/serve.py`、`tests/scenario/test_service_restart.py`、`tests/system/test_serve_kill_recovery.py`，并同步 `scripts/export_cli_contract.py`、`contracts/cli-contract.json`、`docs/architecture.md`、`docs/deployment.md` 与本文件；审计后补：`domain/progress.py` 与 `cli/web.py` 新增 `outstanding_action` 问题种类（页面「问题」段同源显示），前端 `format.ts` 补标签。
- 实际行为：`ServiceWorker.reconcile()` 只读扫描未核对动作（`actions` 里未释放的 `started`）与残留槽位，连同**副作用证据**（候选 diff 的 sha256、工作副本是否存在）列成清单；进程启动时先核对一次，`GET /api/service`／`serve --once --json` 每次重新核对并与进展文档的「问题」段按 `(kind, ref_id)` 去重合并，因此页面、进展接口与常驻状态看到同一份「需人工核对」事实。筛选新增第五道前提 `has_outstanding_action`：存在未释放动作的任务**一律不自动推进**（与执行器内 B03 红线同一口径的第二道闸门）；`startup_review` 与 `startup_checked_at` 进状态文档。
- 验证结果：`make check` **exit 0**（Python **1601 项通过**、3 项真实模型用例未启用跳过、5 项未选；Pyright 0 errors＋1 条既有 warning；CLI 契约与架构契约门禁通过；结构报告 0 失败；前端 **92 项通过**＋真实浏览器 **5 项**）。R4 新增 **8 项**：unit 3（纯规则新增前提、真实未核对动作导致跳过并给出证据、人工释放后重新放行）、scenario 3（强杀现场列出且不重放、干净需求不受他人残留影响、**释放后经常驻进程续跑到验收门**）、system 2（**真实 `kill -9` 后重启**：清单可见、`auto_advance=true` 也不重放、动作集合保持不变；`requirement actions list` 能看到被强杀的动作）。
- 未执行（如实记录）：① `systemctl --user restart` 形式的断电式重启**未在真实宿主验证**（沙箱内无用户 systemd）；② 副作用核对只做到「把候选 diff 身份与工作副本存在性交给人工」，**没有自动判定**副本与记录一致（人工核对步骤见 `docs/deployment.md`）。

2026-10-18（方案验收条件逐条审计，未提交）：按 `docs/resident-service-plan.md` §8/§9 逐条比对现有证据，补掉三处「验收要求有、实测证据没有」的缺口。

- **审计发现并已补齐**：
  1. **R4「未完成动作要出现在页面『问题』段」原本不成立**：`/api/service` 的清单来自 worker 的启动核对，而页面读的是 `/api/progress`；崩溃停在 dev 中途时任务状态仍是「进行中」，读模型不会把它当问题。已修：`domain.progress` 新增问题种类 `outstanding_action`（由 `actions` 记录直接判定，不由任务状态推导），`cli/web.py` 装配该问题项，前端补标签「未核对动作」；同一事实两处判定时合成一条——摘要用读模型文案、现场证据（候选 diff sha256、工作副本是否存在）由 worker 的核对结果补上，因此页面与 `/api/service` 看到同一份事实。证据：`tests/unit/test_web_page.py::test_unreleased_action_becomes_its_own_issue`，`tests/system/test_serve_kill_recovery.py` 现在同时断言 `/api/service` 与 `/api/progress` 两个来源。
  2. **R2「客户端断开后推进」原本只有弱形态**（批准后测试完全不访问服务）。已补真实形态：显式 `POST …/advance` 后用 `SO_LINGER` 发 RST 强制断开、不读响应，服务端仍把 dev/review/test 跑完到验收门（`auto_advance = false` 保证只有这次请求能让它动）。证据：`tests/system/test_serve_async.py::test_explicit_advance_survives_client_disconnect`。
  3. **R3 两条反例缺失**：现已补「需求修订后批准过期任务包被拒且原因原样回传」（409＋`需求已修订`）、「重复批准不重复消耗」（两次批准后批准表仍只有 1 条事实、授权来源不变——领域层对同一版本是幂等，测试核对事实条数而不是强求第二次失败）。证据：`tests/integration/test_serve_operations.py::TestApprovalCounterexamples`。
- **审计确认已有覆盖（未重复造测试）**：R1 全部（`--once`、非法配置、端口占用、SIGTERM 退出码 0 与端口释放、心跳）；R2 决定后唤醒与 `auto_advance` 关闭、停止生效（`test_stop_request_prevents_new_actions`）、并发互斥与同项目交付串行／不同项目并行（`tests/scenario/test_parallel_requirements.py` 12 项）；R3 令牌/跨源/非 POST 拒绝且零业务事实、真实浏览器闭环；R4 强杀不重放、`actions list` 可见、释放后续跑到验收门。§9 的「component 层 HTTP 契约」由 `tests/integration/test_serve_operations.py` 承担（真实回环端口 + 真实 SQLite，覆盖状态码/错误码/405/404 口径），未另建重复层。
- **验证结果（本轮全部门槛，含 CI 同款组合）**：`make check` exit 0（高频层 **1602 项通过**、3 跳过、5 未选；静态门禁与两份契约门禁通过；前端 **92 项**）；`make coverage` exit 0（高频 + 集成 **1775 项通过**，行覆盖 **94.71%**、分支覆盖 **90.08%**）；`make test-system` exit 0（**39 项**）；`make frontend-e2e` exit 0（**5 项真实 Chromium**）。CI 的 `quality.yml` 跑的正是 `check-static coverage test-system frontend-e2e` 这一组合，本地已对齐执行。日志：`.cache/audit-full2.log`、`.cache/audit-coverage3.log`。
- **覆盖门禁当场抓出两处真实退化（这正是它该干的事）**：① 新行为让 R1 的两条集成断言过时——`POST /api/service` 现在先过令牌闸门，拒绝码由 405 变 403（已按新口径改写断言，并保留「被拒写请求零业务事实」的核心断言）；`review_required` 现在是「进展问题段 + worker 核对」的合并结果，不再与问题段逐字相等（改为按 `(kind, ref_id)` 对齐并断言读模型依据被保留）。② 新增代码把分支覆盖压到 89.7%：补了 8 项针对性用例（空请求体、非对象 JSON、停止被拒、合并契约两条分支、显式 `advance_requirement` 成功路径、三类定位与生命周期早退分支）后回到 90.08%。
- **仍未验证（如实保留）**：① systemd user unit 与断电式 `systemctl --user restart`（沙箱无用户 systemd；unit 模板与步骤在 `docs/deployment.md`）；② 真实模型下的常驻长跑（需占用真实 PI，且当前邮件任务在验收门等待人工决定）；③ 副作用核对仍是「把证据交给人工」，不自动判定副本与记录一致。

2026-10-18（方案 §4/§5 设计逐条对表，修掉一处实现缺陷并记录两处偏离，未提交）：把方案的接口设计与已建成实现逐行对比，发现并处理三件事。

- **修掉的实现缺陷（R3 遗留）**：方案 §4.2 定的是推进端点返回 **202 受理**，而实现是**同步阻塞**——`POST …/advance` 会在请求里跑完当前任务的 dev/review/test（分钟级），浏览器和反向代理都会先超时，且默认关闭 `auto_advance` 的部署里页面按钮只能靠这条阻塞请求生效。已改为：端点先**只读判定**前提（不满足立刻 409＋原因，不排注定失败的队），满足则放进 worker 的**进程内排队**并立即返回 202；执行落在下一次心跳，且**不受 `auto_advance` 限制**（关闭开关只表示不自动接续，人工点下的推进照常执行）。排队与结果分别进 `worker.pending_advance` 与 `last_tick`（跳过的需求带具体原因）。`worker.advance_once(only=…)` 保证集合外的需求不会被顺手推进。
- **记录的两处偏离（不改实现，改记录）**：① §4.2 的提交**幂等键（客户端 UUID）**未实现——持久化幂等键需要新增列或表，与 §5「不新建业务状态」直接冲突，属需要所有者取舍的问题（现状：页面在请求期间禁用按钮，跨重启重复提交会建两条需求）；② §4.2 约束「所有写端点都要求 `by`、`reason`」只对批准/验收/停止落实（这三个决定会写进权威记录），提交/推进的 `reason` 可选（没有可绑定的决定记录，收下也无处安放）。两处都写进了方案文档的 as-built 说明，未改写所有者批准时的原文。
- **顺带更正的记录**：§5 原设想启动核对「复用 `domain.progress` 的 `slot_residue`／`interrupted` 分类」，实测不成立（崩在 dev 中途时任务状态仍是「进行中」），因此新增了 `outstanding_action` 种类（上一轮已记录），本轮把它写进方案文档的 as-built 说明。
- **验证结果（实测）**：`make check` exit 0（高频层 **1602 项通过**、3 跳过、5 未选；静态与两份契约门禁通过；前端 **93 项**）；`make coverage` exit 0（高频＋集成 **1785 项通过**，行覆盖 **94.74%**、分支覆盖 **90.11%**）；`make test-system` exit 0（**39 项**）；`make frontend-e2e` exit 0（**5 项真实 Chromium**，其中新增「推进/停止按钮在真实浏览器里显示服务端拒绝原因」）。契约新增 `service_operation_codes`（各写端点成功码）与受理响应字段 `queued`、状态字段 `worker.pending_advance`。日志：`.cache/round4-full.log`、`.cache/round4-coverage.log`。

2026-10-18（邮件候选合并预检：与在途 R1–R4 改动**语义兼容、文本冲突**，未提交）：在验收前把「验收之后会发生什么」先验一遍，避免验收决定踩坑。

- **发现一：文本冲突（需人工解决，但语义兼容）**。`mail-ports` 候选基于 `e22945a` 生成，此后主干前进到 `f1c676e`（第三方改进了架构文档 §2 叙述），候选又新增 6 条 mail 模块行，与 R1–R4 新增的 `domain/service.py`／`graph/worker.py`／`cli/serve.py` 行落在同一张表。直接 `git apply` 失败；`git apply --3way` 后只剩 `docs/architecture.md` 一处冲突，但**自动合并会把 §2 的详细叙述回退成旧版**，并留下「`mail` 层仍是只有层声明、尚无实现模块的保留层」这类已不成立的句子。`contracts/architecture.json` 不能手改，必须用 `scripts/export_architecture_contract.py` 重新导出。
- **发现二：`merge` 现在会被漂移拒绝**。`domain.merge` 要求目标 main 的 HEAD 等于交付时记录的基线提交（B04）。本任务基线 `e22945a`、当前 `f1c676e`，因此**现在验收后 `forgeloop merge` 会拒绝**。两条路：重跑/刷新任务让候选基于当前基线重建（干净、需一次真实模型运行），或手工合并并在合并后的树上重新验证。
- **已做的验证（证明手工合并可接受）**：在 `.cache/` 的临时工作树里做出正确解决（保留主干新版叙述 + 并入 mail 事实 + 修正过时句 + 重新导出契约），随后在该合并树上跑门槛：`make check` **exit 0（1679 项通过、4 跳过；前端 93 项）**，架构契约与 CLI 契约门禁均通过；另单独跑邮件候选自带测试 **78 项**与 R1–R4 相关测试 **136 项**，全绿。产物与配方留在 `.cache/mail-merge-precheck/`（含 `architecture.md.resolved`、`architecture.json.regenerated` 与两个解决脚本），预检工作树取证后已移除，仓库 `git worktree` 登记恢复干净。
- **给验收决定的建议**：若只求邮件能力尽快落地且接受「在合并后的树上重新验证」，按配方手工合并即可（预检已覆盖高频门槛）；若要求交付对当前基线成立（B04 的原意），应先刷新任务再验收。这一步需要所有者选择。

2026-10-18（写操作审计缺口核对 + systemd unit 离线校验，未提交）：把 R3 验收项「审计字段完整」逐端点查实，并把手工验收里可自动化的部分固化。

- **审计现状（逐端点查实，已订正旧记录）**：只有**需求级任务包批准**能回查「谁、从哪来」——`requirement_plan_approvals(approved_by, source)`，页面写 `source=web:<by>`（集成层用**真实 CLI 入口**核对落库，系统层另核对种子需求）。其余四处只有业务事实、没有 actor 列：任务级批准 `approvals(task_id, plan_version, stage, decided_at)`、停止 `stops(task_id, requested_at, confirmed_at, note)`（`note` 承载页面传来的理由）、提交（`requirements` 只有 `created_at`／`status`）、推进（只有 `actions` 的节点与时间）。页面确实要求并校验 `by`（缺 `by` 直接 400），但除批准外无处安放——**没有把 `by` 塞进 `note` 之类的字段冒充审计**（那会污染字段语义）。缺口属持久化变化（补列或补表），方案 §5 又明确「不新建业务状态」，因此**等所有者决定**：补 actor 列/表，还是接受现状。
- **固化为测试（现状快照）**：`tests/integration/test_serve_operations.py::TestAuditFacts` 三条——schema 快照（断言四张表今天的列，将来补 actor 列会失败并提醒同步契约与文档）、真入口落库断言（`('owner', 'web:owner')`）、停止理由原样交给既有入口（`stops.note`）且不塞 `by`。为此给集成测试加了「注入真实 CLI 入口」的夹具（此前只有替身）。
- **systemd unit 离线校验**：`systemd-analyze verify runtime/systemd/forgeloop-serve.service` 本机实测**零输出、退出码 0**；已固化为 `tests/system/test_systemd_unit.py`（4 项：必需指令、`ExecStart` 指向随仓库分发的服务配置且不重复配置 `--host`、模板自带安装/回查步骤与边界声明、`systemd-analyze` 报错特征扫描；工具缺席时跳过）。**仍未验证**：真机 `systemctl --user enable --now`／`restart` 恢复／`journalctl` 日志（沙箱与 CI 无用户 systemd 总线）。
- **前端变异范围纳入 R3 新模块**：`src/actions.ts`（页面写入口的请求构建与结果解读）此前不在 Stryker 范围。先补 15 条针对真实回退行为的单元用例（空串／标量／null 载荷、`queued` 缺身份、未 trim 输入、非 JSON 成功体、空 code+detail 等），把分数从 **72.95% 提到 90.16%**，再把该文件纳入夜间范围（**不动任何阈值**）；全量实跑 **93.45%**（format 96.99／progress 92.59／actions 90.16）。剩余 4 个幸存者逐项复核为**等价变异**（同表达式内的兄弟子句仍起守卫作用；`.catch(() => undefined)` 与 `({})` 落到同一兜底文案），按既有流程登记到 `config/quality-policy.toml` 的 `[[frontend.reviewed_survivors]]` 并写明理由；顺带修正 `format.ts` 三条登记的行号漂移（R4 新增问题种类标签把行号下移一行），并补一条「未核对动作 → 未核对动作」标签用例。`scripts/check_frontend_mutation.py` 现报 **击杀率 96.13%（未检出 13，登记 12）**。
- **验证结果（实测）**：`make check` exit 0（高频 **1602 项**、前端 **109 项**，静态与两份契约门禁通过）；`make test-system` exit 0（**43 项**，新增 4 项）；`make coverage` exit 0（高频＋集成 **1788 项**，行 **94.74%**、分支 **90.11%**）；`make frontend-check` exit 0；集成层 `test_serve_operations.py` 单项 **33 项**通过；`scripts/check_frontend_mutation.py` 报击杀率 **96.13%**。日志：`.cache/round6-*.log`。
- **发现但本轮未做（下一项候选）**：R1 的纯规则模块 `src/forgeloop/domain/service.py` **不在** Python 变异范围（`pyproject.toml` 的 `only_mutate` 只含既有 9 个 domain 模块）。它与已纳入的 `domain/status.py` 同类（纯规则、unit+property 判定），值得按同一流程实测后决定是否纳入；本轮 mutmut CLI 无「只跑单模块」选项（仅支持 `--max-children` 与变异体名），需临时收窄配置或加入后全量跑再按 `scripts/check_mutation_stats.py` 判定。

2026-10-18（Python 变异范围实测：`domain/service.py` 补测后仍不纳入 + 变异沙箱陈旧陷阱，未提交）：把上一轮记录的候选做完——实测 R1 纯规则模块的变异状态，并按项目既有口径给出结论。

- **实测结果（254 个变异体，unit+property 判定）**：补测前 206 杀死／48 存活（81.1%）；补测后 **217 杀死／37 存活（85.4%）**，`no_tests = 0`。37 个幸存者里 **12 个是 `cast("...")` 实参变异**（运行时 no-op，天然等价），其余 **25 个全是只出现在错误消息里的文案**（字段名、边界文案、回环地址清单）。
- **结论：仍不纳入 `only_mutate`**，理由是**该模块在当前口径下摸不到门槛**——`general_killed_min = 90` 需要 ≥229 杀死，而 217 已是「不把消息文本当契约」时的天花板；按本文件既有登记先例（「错误消息文本变异……消息内容非行为契约；测试断言异常类型与关键语义，不断言全文」），那 25 条只能登记、不能靠断言全文杀死。要纳入必须先由所有者决定：把该模块的消息文本当契约，或为它单列阈值（**不得为过门禁擅自放宽**）。实测与结论已写进 `pyproject.toml` 的 `[tool.mutmut]` 注释，统计留档 `.cache/round7-service-mutation-stats.json`。
- **本轮真正拿到的行为覆盖（11 个变异体由补测杀死）**：`tests/unit/test_service_config.py` 新增 4 组断言——① 下限值**被接受**（`poll_seconds = 1`、`max_concurrent = 1`、`port = 65535`；此前只测了拒绝侧）；② 可选字段 `baseline` 的**缺省（键缺失走 None 分支）与显式空串两种形态**都要成立；③ 档案解析结果必须包含 `path`（此前只断言其它字段）；④ 命令是**字符串**（而非数组）时必须按「字符串数组」明确拒绝，不能按字符拆开照收。
- **顺带查实的真实陷阱（已写进配置注释）**：`mutants/` 只在**首次**创建时整体拷贝，之后同一目录里的测试与包数据**不随工作区刷新**。实测两例：改完测试直接重跑，数字纹丝不动（陈旧夹具给出假结论）；`mutants/` 里 10-17 的页面 HTML 陈旧，直接让变异**基线失败**（`test_page_carries_the_token_placeholder_and_operation_panel`），即本地复用旧 `mutants/` 会得到错误结论。CI 与夜间作业是干净检出，不受影响；本轮已把该注意写进 `pyproject.toml` 并清掉复现用的 `mutants/`。
- **验证结果**：`tests/unit/test_service_config.py` **41 项通过**；`pyproject.toml` 除注释外**与备份字节一致**（临时收窄的 `only_mutate` 已恢复原样）。

2026-10-18（阻塞与待决：R1–R4 已交付并验证，邮件线等待所有者决定）：本轮不新增实现，先核实阻塞事实，并把「已交付 / 已排除 / 待所有者决定」三份清单固化，便于一次性决策。

- **已交付并逐层验证（R1–R4）**：R1 常驻骨架、R2 异步执行与唤醒（`auto_advance` 默认关闭）、R3 页面操作入口（五个写端点 + 令牌/同源/体量闸门，推进为 202 受理）、R4 重启恢复与副作用核对（未核对动作不重放、页面「问题」段同源可见）。方案 §8 的验收条件已逐条对表补齐缺口（`outstanding_action` 问题种类、断线推进真实验证、过期/重复批准反例），并做过设计与实现的对表（推进端点从同步阻塞改为方案原定的 202 受理）、待验收候选与在途改动的合并预检（语义兼容、文本需人工解 1 处 + 重新导出契约）、以及变异范围对齐（前端纳入 `actions.ts`，Python 侧 `domain/service.py` 实测后仍不纳入）。
- **当前门槛（本轮实测）**：`make check` **exit 0**（高频 **1606 项通过**、3 跳过、5 未选；前端 **109 项**；静态与两份契约门禁通过）；近期其余门槛同样为绿：`make test-system` 43 项、`make coverage` 1788 项（行 94.74%／分支 90.11%）、`make frontend-e2e` 5 项真实 Chromium、前端变异击杀率 96.13%。
- **待所有者决定（阻塞邮件线与三项口径，均无法由 Agent 代签）**：
  1. **邮件任务验收**：`task-req-20261016021551-ed498a-v6-mail-ports` 停在 `awaiting_acceptance`，需求 `executing`「等待决定」。验收命令已给过多次（`approve <task> --stage acceptance --decision approved`）；按项目规则**人工验收不得由 Agent 代签**。
  2. **邮件落地路径**：候选基线 `e22945a`，当前 HEAD `f1c676e`，`forgeloop merge` 会按 B04 漂移拒绝。二选一：刷新任务（对当前基线重建，需一次真实模型运行）或按已验证配方手工合并（产物与脚本在 `.cache/mail-merge-precheck/`）。
  3. **写操作审计缺口**：任务级批准、停止、提交、推进在权威记录里没有 actor 列（现状快照已用测试钉住）。补列/补表属持久化变化，方案 §5 又写「不新建业务状态」。
  4. **提交幂等键**（方案 §4.2 设计的客户端 UUID）：持久化幂等键需要新列或新表，与同一约束冲突。
  5. **`domain/service.py` 变异范围**：实测 85.4% 摸不到 `general_killed_min = 90`，需决定「消息文本当契约 / 单列阈值 / 维持现状」。
- **未执行且需要宿主或授权**：systemd 真机验收（`systemctl --user enable --now`／`restart` 恢复／`journalctl` 日志，沙箱与 CI 无用户 systemd 总线；unit 文件已由 `systemd-analyze verify` 离线校验并通过）、真实模型下的常驻长跑（需一个已批准任务包与模型开销授权）。
- **结论（如实记录）**：在不新增所有者决策的前提下，本目标的在途工作已做尽；继续推进只会重复验证或改动口径。目标按策略标记为阻塞，等上述决定后恢复。

2026-10-18（所有者决定落地：幂等键 + 审计归属列，未提交）：按所有者 2026-10-18 的三项决定实现前两项（第三项「service.py 纳入变异」下一轮做），全部走**既有表加列**，不新建业务状态表。

- **幂等键（方案 §4.2 的客户端 UUID）**：`requirements` 加 `client_key` 列 + **部分唯一索引**（`WHERE client_key != ''`，历史记录与不传键的调用不参与唯一性，因此不会互相冲突）。语义：同键同内容 → 返回既有需求（`created=False`，HTTP 200 + `idempotent: true`，不写任何记录）；同键不同内容 → fail-closed（`IdempotencyConflictError` → HTTP 409 `idempotency_conflict`）；键为空 → 保持历史行为。CLI `requirement submit --client-key`，页面用 `crypto.randomUUID()`（无该 API 时退回时间戳+随机串）生成，**失败重试复用同一个键、成功后才换新键**。端点另加键格式校验（≤128 字符、不含空白 → 400 `invalid_key`）。
- **审计归属列**：`approvals` 加 `approved_by`/`source`；`stops` 加 `requested_by`/`source`（理由仍在 `note`，不与归属混装）；`requirements` 加 `submitted_by`/`source`，以及需求级验收的 `accepted_at`/`accepted_by`/`acceptance_source`/`acceptance_fingerprint`。四类写操作现在都能回查「谁、从哪来」；**需求级整体验收同时绑定材料指纹**（64 位 sha256，按任务身份排序后哈希，顺序无关、换材料即变），此前 `accept` 只翻一个状态、连验收时刻都不留。CLI 相应新增 `--by`/`--source`（`requirement submit|accept`、`approve`、`stop`，取不到时按空串如实留空，不编造身份），页面写 `web:<by>`。`requirement status --json` 新增 `submission` 与 `acceptance` 两段，审计可经 CLI/HTTP 回查。
- **旧库平滑升级**：两处 `_migrate` 用 `ALTER TABLE` 补列（沿用缺陷 #24 时 `resume_node` 的同一条路），并补建唯一索引；单元层用**旧版建表语句造真实旧库**验证：旧记录照常可读、新列以空串回填、新索引存在。
- **契约与文档**：`contracts/cli-contract.json` 重新导出（需求状态文档新增 `submission`／`acceptance`）；`docs/architecture.md` 的「写操作的审计边界」行改写为四类操作的落库位置；方案文档 as-built 说明更新（幂等键已落实、审计归属已补齐）。页面 `page.ts` 因新增提交接线触发「函数过长」提示，已把提交接线抽成 `wireSubmit`。
- **验证结果（本轮实测）**：`make check` exit 0（高频 **1619 项**＝新增 13 项，前端 **113 项**＝新增 4 项；静态与两份契约门禁通过）；`make test-system` exit 0（**43 项**）；`make coverage` exit 0（高频＋集成 **1809 项**，行 **94.76%**、分支 **90.21%**）；新增单测 13 项（幂等三种语义、提交/批准/停止/验收归属、旧库升级两例、指纹顺序无关与敏感性）＋集成 4 项（同键同内容 200/同键异内容 409/非法键 400、schema 快照改为「四类操作都有归属」、真实 CLI 入口的验收归属）。下一轮：`domain/service.py` 纳入变异（消息即契约 + 登记 12 条 `cast` 等价变异）。

2026-10-18（第 3 项决定落地：`domain/service.py` 纳入变异，未提交）：按所有者决定取「**消息即契约**」，把 R1 的配置纯规则纳入 Python 变异范围，并顺带修好两处会让变异运行给出错误结论的环境缺口。

- **做法**：`tests/unit/test_service_config.py` 新增 `TestMessagesAreTheContract`（7 个用例、逐字断言 20+ 条文案）——字段名、范围写法（`1..65535` 与 `>= 1`）、未知键清单与分隔符「、」、项目档案各级字段名、以及回环地址清单。口径理由写进了测试注释、`pyproject.toml` 的 `[tool.mutmut]` 注释与 `config/quality-policy.toml`：配置校验模块的**文案就是运维界面**（人照着这句改 `config/service.toml`），因此对本模块是既有「消息文本非行为契约」先例的**收紧例外**，其余模块的先例不变。
- **实测结果（254 个变异体，unit+property 判定，沙箱全新）**：**242 杀死 / 12 存活 = 95.3%**，`no_tests = 0`；12 个存活**全部**是 `cast("Sequence[object]"／"Mapping[str, object]", …)` 的实参变异（`cast` 运行时是 no-op，天然等价），已逐条登记到 `config/quality-policy.toml` 的 `[[mutation.reviewed_survivors]]`；`scripts/check_mutation_stats.py` 报 **Mutation gate passed: 242/254 killed, 12 survivors (154 reviewed)**。统计留档 `.cache/round9-service-mutation-stats.json`。
- **顺带修好的两处环境缺口（都是会给出错误结论的真实缺陷）**：
  1. **变异沙箱缺 `contracts/`**：`tests/component/test_cli_contract.py` 要读 `contracts/cli-contract.json`，`also_copy` 里没有它 → 基线直接失败（`failed to collect stats`）。扩大范围后才暴露（跑窄范围时该用例没被选中）。已把 `contracts` 加进 `also_copy`。
  2. **变异基线把系统层也跑了**：`pytest_add_cli_args_test_selection` 只限制「每个变异体跑哪些测试」，**基线仍收集全套**；系统层要起真实进程与回环端口，在沙箱里撞 `pytest-timeout`（实测卡在 `tests/system/test_serve_async.py`）→ 整个运行报失败。已补 `--ignore=tests/system` 与 `--ignore=tests/integration`，让基线口径与选择口径一致（变异由 unit+property 判定）。这两条都写进了配置注释。
- **一处需要留意的本地现象**：本轮本地统计只覆盖 `service.py`（临时收窄范围验证），因此 `check_mutation_stats.py` 会把其它模块的 142 条登记报成「本次未出现」的 HINT——那只说明本地跑的不是全量范围，**不影响门禁判定**；全量由夜间作业/CI 干净检出跑。
- **验证结果**：`make check` exit 0（高频 **1625 项**＝新增 6 项，前端 **113 项**；静态与两份契约门禁通过）；变异门禁本地通过（95.3%）。三项所有者决定至此全部落地。

2026-10-18（邮件候选合并预检复跑：三项决定之后仍然只差人工验收，未提交）：上一轮那次预检是在「幂等键 + 审计归属列 + 变异纳入」之前做的，本轮在当前工作树上重跑，确认结论没变、且新代码与候选能共存。

- **冲突面与上次完全一致**：候选对当前树做 `git apply --3way` 后，13 个路径里只有 `docs/architecture.md` 冲突（§2 第 2 条一行 + 第 3 节模块清单表的 mail/cli 行），其余（`contracts/architecture.json`、`src/forgeloop/mail/__init__.py`、6 个 mail 模块、4 个测试文件、`config/mail.example.toml`）自动合并。按已记录的五条自动解规则处理后**零冲突标记**，契约用 `scripts/export_architecture_contract.py` 重新导出（**66 模块、9 条层边**），而不是手改 JSON。
- **验证结果（当前树 + 候选 + 三项决定，实测）**：`make check` **exit 0（1702 项通过、4 跳过；前端 113 项）**；架构契约与 CLI 契约门禁均通过；邮件候选自带测试与新增幂等/归属测试合计 **91 项通过**。产物刷新在 `.cache/mail-merge-precheck/`（`architecture.md.resolved`、`architecture.json.regenerated`、两个解决脚本、README 已写两次预检的数字）。预检工作树取证后已移除。
- **结论**：手工合并这条路**当前依旧可行且已验证**（代价是 `docs/architecture.md` 一处人工裁定 + 契约再生成 + 合并后重跑门槛）；`merge` 仍会因基线漂移（交付 `e22945a` vs 当前 `f1c676e`）拒绝，因此仍需所有者在「刷新任务」与「手工合并」之间选一条，并作出邮件任务的人工验收。**这一步只有所有者能做，Agent 不代签。**

2026-10-18（文档收口 + 提交键跨刷新加固，未提交）：把本轮新增的概念与门槛口径写进权威文档，并收掉最后一个自足缺口。

- **术语表（`CONTEXT.md`）新增「常驻与页面入口」一节**：常驻服务、启动核对、未核对动作、页面写入口、推进受理、客户端幂等键、审计归属、验收材料指纹——每条都按本文件既有格式给出定义与 `_Avoid_`（典型误用）。此前这三批引入的领域概念在术语表里**一条都没有**，属于文档滞后。
- **`docs/engineering-reliability.md` 第 5 节补「变异范围与口径的实测记录」**：`domain/service.py` 的「消息即契约」收紧例外（254 变异体、242 杀死／12 等价、95.3%）、前端 `src/actions.ts` 先补测再纳入（72.95% → 90.16%，全量 93.45%，检查脚本 96.13%），以及两处会让变异运行给出**错误结论**的环境缺口（沙箱缺 `contracts/` → 基线失败；基线仍收集系统层 → 沙箱超时；`mutants/` 只在首次创建时拷贝，本地改测试后必须删目录重跑）。
- **提交键跨刷新加固（前端）**：提交键除内存变量外写入 `sessionStorage`（`forgeloop:submit-key`），**刷新页面后复用同一个键**——此前刷新即换键，服务端的幂等去重就接不住「刷新后重试」这一常见路径；新开标签页/浏览器仍是新键（新的一次提交意图）。存储不可用（隐私模式、沙箱 iframe、连属性访问都抛错）时静默退化为内存键，不影响提交。
- **验证结果**：`make check` exit 0（高频 **1625 项**、前端 **113 项**）；前端新增 4 项暂存键单测（读写、无存储、存储抛错、空白键）。文档改动不影响门槛。

2026-10-18（最终一致性验证 + 幂等的真实浏览器端到端，未提交）：在"三项决定"落地之后，把此前分散跑过的门槛在同一份代码上重跑一遍，并补上唯一一层没在改动后验证过的路径——真实浏览器里的幂等。

- **补上的真实浏览器验证（此前 e2e 层没覆盖幂等键）**：新增 `frontend/tests/e2e/operations.spec.ts` 用例——第一次提交让请求**真的到达服务端**（`route.fetch()`，服务端会建需求），但用 `route.abort()` 让客户端拿不到响应；随后**刷新页面**再提交同一内容，断言权威记录**只多了一条**（`/api/progress` 计数），且刷新后 `sessionStorage` 里的提交键仍是同一个。这条用例覆盖的正是幂等键存在的理由：网络抖动后的重试。`make frontend-e2e` **6 项通过**（原 5 项 + 新增 1 项）。
- **同一份代码上的全部门槛（本轮实测）**：`make check` exit 0（高频 **1625 项**、前端 **117 项**）；`make test-system` exit 0（**43 项**）；`make coverage` exit 0（高频＋集成 **1815 项**，行 **94.79%**、分支 **90.34%**）；`make frontend-e2e` exit 0（**6 项真实 Chromium**）；Python 变异门禁上一轮实测通过（`domain/service.py` 95.3%、12 条等价登记）；前端变异检查脚本 **96.13%**。
- **未验证项（如实保留，未变）**：① systemd 真机（`systemctl --user enable --now`／`restart` 恢复／`journalctl`）需在目标宿主执行，沙箱与 CI 无用户 systemd 总线；② 真实模型下的常驻长跑需一个已批准任务包与模型开销授权；③ 副作用核对目前只把证据（候选 diff 身份、工作副本是否存在）交给人工，不自动判定一致性；④ 邮件候选的落地（手工合并或刷新任务）与邮件任务的人工验收仍待所有者决定。

2026-10-18（阻塞收口：不需要所有者决策的工作已做尽）：本轮不再新增实现，只做现状核对与阻塞原因固化。

- **核对结果**：`HEAD` 仍为 `f1c676e`、工作树 **64 项**改动未提交；`mail-ports` 任务仍停在 `awaiting_acceptance`，需求状态 `executing`「等待决定: task-…-v6-mail-ports」；CLI 契约与架构契约自检通过。与第 8 轮首次标记阻塞时相比，**当时列的五项里三项已由所有者决定并落地**（幂等键加列、审计归属列、`domain/service.py` 纳入变异），剩下的阻塞面因此收窄为下面两类。
- **需要所有者决定（阻塞邮件线，Agent 不得代签）**：
  1. **邮件任务的人工验收**：`approve task-req-20261016021551-ed498a-v6-mail-ports --stage acceptance --decision approved`（命令与候选材料已多次给出）。
  2. **邮件落地路径二选一**：刷新任务（对当前基线 `f1c676e` 重建，干净、需一次真实模型运行）或手工合并（`.cache/mail-merge-precheck/` 已备好当前树的解与验证：合并后 `make check` 1702 项全绿；`merge` 本身会因交付基线 `e22945a` 漂移而拒绝）。
- **需要宿主机或授权（本环境不可执行）**：① systemd 真机验收（unit 文件已过 `systemd-analyze verify` 离线校验，沙箱无用户 systemd 总线）；② 真实模型下的常驻长跑（需一个已批准任务包与模型开销授权）。
- **已核实不属于「未做」的项**：R1–R4 全部交付并逐条对表（含页面「问题」段的未核对动作、断线推进、过期/重复批准反例、kill -9 重启不重放）；三门硬规则由代码强制（回环限定、令牌+同源、批准绑定/未核对动作不放行）；审计归属与幂等键按所有者决定落地；变异范围前端 96.13%、Python `service.py` 95.3%。
- **本轮门槛**：契约自检通过（上一轮已在同一份代码上跑齐 `make check` 1625/117、`test-system` 43、`coverage` 1815（行 94.79%／分支 90.34%）、`frontend-e2e` 6）。

2026-10-18（提交 `d6a7bed` + 刷新路线被机器拒绝：该操作当前不存在，未提交任何伪造记录）：按所有者决定先提交在途批次，再以新 HEAD 为基线刷新邮件任务；刷新这一步被确定性校验 fail-closed 拦下，如实记录经过与结论。

- **提交完成**：所有者 2026-10-18 指令「先提交在途 64 项，再以新 HEAD 为基线刷新」下，本机策略登记当日批次授权（`.cache/forgeloop/commit-policy.toml`，入库存模板不变），`check_commit_policy.py --validate-config/--check-now` 均放行（判定 `outside_work_hours`），提交前 `make check` exit 0（高频 1625 项 + 前端 117 项），提交为 **`d6a7bed feat(serve): 常驻服务与页面操作入口、审计归属与幂等键`**（63 项变更）。**并发会话**当时正在同一工作树里开发面板功能（`cli/panel.py`、`domain/conversation.py`、`domain/projects.py`、`graph/conversation.py`、`records/conversations.py`），其未跟踪文件让预提交钩子的全树 pyright/ruff 失败；所有者指示该会话改用独立 worktree，其文件随后迁出（迁出时也带走了它在 `domain/service.py` 内的面板改动），本提交因此只含本会话批次；`docs/branch-protection.md` 的既有改动保留在工作树、未提交。
- **刷新被拒绝（确定性校验按设计工作）**：`requirement retry --node dev --baseline d6a7bed` 的返回是——「任务状态不符：当前 awaiting_acceptance，只有 interrupted 或存在 halted_reason 的任务可人工续跑」「检查点没有 halted_reason，无需指定重入节点 dev；请去掉 --node」。即：**「按新基线刷新同一任务」在当前实现里没有受支持的入口**；`retry` 的语义被严格限定为「不可归因的陈旧中断」，不允许用它做基线迁移（这是我此前实现缺陷 #24 时一并加固的纪律）。现场随后恢复原样：工作副本改名已撤回、任务仍为 `awaiting_acceptance`、续跑决定记录未新增（仍 10 条），旧候选另存 `candidate.baseline-e22945a.diff` 备查。
- **三条可行路径（需所有者选一条）**：① **实现受控的「刷新」操作**（新 CLI + 人工决定记录 + 工作副本轮换 + 前置校验 + 测试/文档/契约）：符合所有者原意，属开发工作，需一轮以上；② **重新规划**：`requirement revise` 追加版本 → 旧任务包 v6 与批准失效 → 重新 `plan` → 所有者批准新任务包 → `advance` 在新基线上创建并跑新任务（流程内合法，但需要所有者再次批准任务包、且任务身份/版本会变）；③ **手工合并**（所有者此前排除，但产物与验证仍有效：`.cache/mail-merge-precheck/`，合并树 `make check` 1702 项全绿）。

2026-10-18（第 14 轮：把「① 受控刷新」写成可评审方案，未实现、未提交）：所有者要求用大白话说明当前冲突后，三条路径仍未拍板。按项目规矩「确需扩大范围先交方案评审，不自行扩写清单取得授权」，本轮只产出方案文档，不动代码。

- **新增 [`docs/adr/0003-requirement-baseline-refresh.md`](adr/0003-requirement-baseline-refresh.md)（状态：提议，待评审）**：把「按新基线刷新同一任务」定义为受控操作 `requirement refresh`——同一任务身份与任务包版本、只换批准基线、重跑 dev→review→test、候选对新基线计算；旧现场与旧候选封存为 `baseline-<旧提交>`；必须留下人工决定（谁/何时/理由/新旧基线）。
- **机器强制的前置条件（逐条 fail-closed，无 `--force`）**：批准未过期、任务停在该决策边界（`interrupted` 无归因仍走既有 `retry`）、无未核对动作、无残留槽位、检查点身份可信、新基线是真实提交且与当前基线不同、无正在运行的推进、需求未停止或终态。
- **明确不做**：不放行验收、不清失败累计、不改授权额度与任务包版本、不自动归并——避免把「刷新」变成绕过人工门或改写历史的万能钥匙。
- **未决点已列出请所有者拍板**：能否刷新已交付任务（建议禁止）、是否计入失败轮次（建议不计入）、旧现场保留期限（建议留到新交付落地）、是否限制刷新次数（建议不设上限但每次独立记录）。
- **当前阻塞未变**：邮件任务仍在 `awaiting_acceptance`（任务身份 `task-req-20261016021551-ed498a-v6-mail-ports`），落地路径三选一未定（① 实现上述刷新／② 走重新规划需所有者再批任务包／③ 手工合并，产物在 `.cache/mail-merge-precheck/`，合并树 `make check` 1702 项全绿）。主干已提交 `d6a7bed`，工作树仅余并发会话遗留的 `docs/branch-protection.md`（未动、未提交）。

2026-10-18（所有者四项决定冻结「刷新」语义；本轮完成方案定稿与技术勘察，未动代码）：所有者对 ADR 0003 的四个未决点给出决定，语义定稿，实现留待后续轮次（硬规则代码必须与两侧行为测试一起落）。

- **决定内容**：① 刷新需要人工批准；② **禁止刷新已交付的任务**（后续改动走新需求）；③ 旧基线／commit 丢失时，任务**重新分析是否已完成**并在**新基线上做实现校准**，旧基线记录、校准原因与过程全部保留；④ 刷新**不计入失败轮次**；⑤ 旧现场**归档冷备份**。ADR 0003 状态改为「已接受（尚未实现）」，并补两条派生硬性要求：命令必须要求非空 `--by`／`--reason` 且无 `--force` 可绕过；基线丢失必须显式声明（`--baseline-lost`）并写 `old_baseline_lost=true` 与校准说明，未声明即拒绝。
- **技术关键（本轮勘察得出，直接决定实现是否有效）**：停在验收门的检查点 `next_nodes=('gate_acceptance',)` 且无 `halted_reason`，执行器据 `_keeps_waiting` 会一直等人工门——因此刷新**不能**只复用 `retry` 的「清除 halted_reason」通路；必须由 `read_authorized_checkpoint` 在处理刷新决定时，合成绑定当前检查点身份／任务包版本的重入状态（`resumed_from_halt=True`、`halted_node='dev'`、`next_nodes=('dev',)`），不匹配则不合成、保持 fail-closed。此结论已写入 ADR 的实现方案（含逐文件改动表与两侧测试矩阵）。
- **邮件任务保持原样**：仍在 `awaiting_acceptance`，工作副本与候选未做任何改动（上一轮的改名已撤回、无新增决定记录）。四选一路径不变，等实现完成后即可按所有者原意刷新。

2026-10-18（所有者批准后实现「任务↔commit 累积关联」并改判归并规则，未提交）：把「待验收任务不存在漂移问题」的模型落成代码，同时把归并的硬判据从「主干等于交付基线」换成与模型一致的两条。

- **新增关联表 `task_commits`**（`records.sqlite`，只追加不覆盖）：`task_id + commit_sha + relation`，`relation ∈ {implementation, acceptance, merge}`，同任务同提交同关系幂等；提交号必须 7-64 位十六进制、关系非法即拒绝（fail-closed）。一个任务可关联多个提交——验收不通过继续改即累加，关联不断裂。
- **验收落库**：`approve --stage acceptance` 通过时记录两类事实——任务工作副本里「批准基线..HEAD」的产出提交（`implementation`）与项目仓库当时的 HEAD（`acceptance`）；取不到（非 git 现场、路径缺失）如实跳过并打印原因，不编造提交号。
- **归并改判**：`check_merge_readiness` 不再接受 `main_head`／`baseline_commit`，改为「**验收材料未变**（`check_acceptance_content` 与验收绑定比对）+ **候选可干净应用**（适配层 `git apply --check` 预检）」；适配层 `_require_clean_main` 去掉「HEAD == 基线」，`create_candidate_branch` 与 `merge_candidate_to_main` 共用同一组约束；冲突 fail-closed 提示人工解决并留痕，不自动拼接；工作树不干净的提示保持原样（先判脏树、再判可应用性）；归并成功后把归并提交记为 `merge`。CLI 新增 `merge --by`。
- **文档与契约**：`docs/architecture.md` 的 domain/merge 模块行、main 保护段、记录表清单（28 → 29 张，新增 `task_commits`）、CLI 命令组与持久化小节同步；CLI 契约重新导出并通过；架构契约自检通过。
- **验证**：`make check` **exit 0**（高频 **1631 项**＝新增 6 项，前端 117 项）。改写测试 11 个文件：新增关联表 5 项；归并判定 3 项改为「材料漂移拒绝」「冲突拒绝并提示人工」「主干前进不再是入参」；场景层原「拒绝漂移」用例改为「主干前进仍可归并 + 归并提交落关联」。
- **对邮件任务的含义（按所有者模型）**：它属于「代码尚未 commit」的情形——**不需要刷新**，继续等人工验收；验收通过后走归并（若候选与当前 main 冲突，按新规则 fail-closed 要求人工解决并留痕），归并提交自动落进关联表。

2026-10-18（按所有者「按 C 办」决定：收信为硬路径、回执 best-effort；真实 QQ 全流程跑通，未提交前已过门槛）：邮件线的卡点从"设计缺陷"变成"已跑通"。

- **所有者决定（原话"按C办，优先跑通全流程，非必要需求不要卡点"）**：SMTP 只做**单向回执**、失败不阻断需求流转；不拿邮件做消歧交互（消歧走页面/CLI）；IMAP 收信是硬路径。
- **根因修复**：`adapter/mail.py` 的入向拉取默认从 `SEARCH UNSEEN` 改为 `SEARCH ALL`（新增 `only_unseen` 开关保留旧行为），由既有 `Message-ID` 幂等接缝去重。真实环境暴露的问题：共享邮箱里客户端会把邮件标为已读（实测收件箱 126 封**未读 0**），`UNSEEN` 永远拉不到本应处理的邮件。
- **真实 QQ 全流程已跑通（实测）**：建需求 → 真实 SMTP 投递到本人邮箱（被 QQ 过滤规则归档进 `FORGE_INBOX`）→ `mail poll --once --imap-folder '&UXZO1mWHTvZZOQ-/FORGE_INBOX'` **fetched=12 registered=12 skipped=0 errors=0**，本次邮件成功关联到需求（`req-20261018142704-17adf7`，给出 `disambiguate` 待确认建议）→ `mail confirm` best-effort 回执 `sent: true`。权威记录：`mail_inbound 12`、`mail_threads 1`、`mail_deliveries 1`。
- **交付面**：`mail-ports` 已验收（关联 `acceptance d6a7bed`）并归并（`merge e8cc3fb`）；`mail-smtp-send` 按决定**降级为非卡点**（回执 best-effort），优先保证收信闭环——它此前因 PI 模型请求超时（外部原因）停在 `pi_dev_unsettled`，不再作为阻塞项。
- **验证**：`make check` **exit 0（1711 项 + 前端 117）**；架构说明补记拉取口径。

2026-10-18（邮件收口：把已验收的 mail-ports 配置层接上 CLI，未提交前已过门槛）：所有者决定"接配置"后，`mail poll`／`mail confirm` 不再需要一长串连接参数，生产环境只需一份配置文件。

- **接线内容**：两个命令新增 `--config`；`--imap-*`／`--smtp-*` 由必填改为可选，**显式参数优先**，不足时依次由「配置解析链（`--config` > `FORGELOOP_MAIL_CONFIG` > 仓库 `config/mail.toml` > `~/.config/forgeloop/mail.toml`）+ provider 预设（QQ：`smtp.qq.com:465`／`imap.qq.com:993`）+ 口令候选链（含所有者现用的 `~/.config/forgeloop/mail-secret`，格式"第 1 行邮箱、第 2 行授权码"）」补齐；口令不可用时逐候选报告状态后 fail-closed。
- **只在显式参数不足以建连时才读配置**：显式调用（既有测试、本地假服务器）完全沿用旧行为，不会被机器上别的邮件配置牵连——这条是补测时发现的回归（真实主机上存在 `~/.config/mail.toml`，会把显式调用的测试打挂），已修。
- **架构变更（有意为之，已同步）**：`cli` 现在依赖 `mail` 层读取配置/预设/口令，因此 `LAYER_RULES` 允许集合新增 `cli -> mail`（`mail` 自身仍不依赖任何其它层），`docs/architecture.md` 的层表与 §2 表述同步更新，架构契约重新导出（**66 模块、10 条层边**）——**架构门禁先拦下了这次越层，按规矩同步后才通过**。
- **真机验证（只用 `--config`）**：`mail poll --once --project ForgeLoop --config .cache/mail-config/mail.toml`（`folder` 指向 `FORGE_INBOX` 的 modified UTF-7 完整路径）真实登录 QQ 并登记成功，`errors=0`，给出待确认建议；口令经 `FORGELOOP_MAIL_SECRET` 指向生产口令文件。
- **验证**：`make check` exit 0（高频 **1715 项**＝新增 4 项配置解析测试，前端 117 项）；架构契约与 CLI 契约门禁通过。

2026-10-18（真实场景验收方案成文；`auto_analyze` 未落实项如实登记）：所有者问及 `auto_analyze` 作用与真实场景验收方案，核查后如实记录。

- **`auto_analyze` 现状：有名字、没作用**。需求文本定义为"提交后按所有者配置的 auto_analyze 决定是否自动分析"，但全仓库只在 `mail/config.py` 被解析与校验（须为布尔），**没有任何消费点**；`cli/mail.py` 从不读它，模板里也没有注释。故 `true` 与 `false` 当前**行为完全相同**（都在登记后停待人工确认）。按纪律登记为**未落实项**：要么接线（`true` → 登记后自动进入只读分析，失败不影响已登记事实），要么从模板移除；建议前者，属新行为需所有者点头。
- **新增 [`docs/resident-service-acceptance.md`](resident-service-acceptance.md)**：只覆盖必须在真实环境执行的验收（离线门槛不重复），分 A systemd 真机、B 重启恢复与不盲目重放、C 真实模型长跑、D 邮件真机、E 未落实项、F 判据汇总；每条写明前提、命令、通过判据、证据留存与不通过时的处置，并标注执行者（所有者/Agent）。方案明确：任一判据不满足即不通过，不放宽判据、不补造记录。
- 邮件部分据本轮实测标注状态：D1–D4、D6 **已验**（真实发信被所有者确认收到、`fetched=12 registered=12 errors=0`、未读 0 仍能拉取、`sent=true`），D5（仅用生产配置 `~/.config/forgeloop/mail.toml` 不带参数运行）**待复跑确认**。

2026-10-18（本机自动部署方案成文，待所有者评审）：所有者要求支持 CD 与自动部署且目标为**本机**；按项目规矩先交方案评审，本轮不动代码。

- **新增 [`docs/adr/0004-local-cd-auto-deploy.md`](adr/0004-local-cd-auto-deploy.md)（提议）**：核查后确认**受控部署器已具备**——`release` 产出 wheel 与回执（产物 sha256）、`deploy` 装进版本目录并**原子激活**（幂等 noop、记录上一版本）、`rollback` 可回退。缺的是**触发与闭环**：常驻 worker 增加受控部署环节（只读筛选"已授权发布且本机版本落后"→ 调既有 `deploy` → 健康检查 → 回执 → **失败自动回滚**），开关 `auto_deploy` 默认关闭（与 `auto_advance` 同口径，开启需人工决定并落库）。
- **硬性前提（fail-closed）**：产物已发布且过就绪判定；`sha256` 与回执一致（不接受重新构建）；prefix 必须等于常驻服务当前运行版本的 prefix（杜绝"部署了但跑的还是旧的"）；部署与任务执行互斥；健康检查失败自动回滚、回滚失败停在明确状态；`auto_deploy` 关闭时只报告不安装。
- **受限环境的应对**：目标在本机时**不需要跨机传输与生产凭据**；受限的只是写工作区外路径（systemd unit、部署前缀），属一次性 bootstrap，由所有者执行或显式放行——本 ADR 给出 4 步接入清单。
- **待拍板三点**：`auto_deploy` 打开后是否每次发布仍需确认（建议默认关闭 + 打开后全自动、页面保留"立即部署"）；健康检查判据（建议 `<prefix>/current/bin/forgeloop serve --once --json` 退出码与 JSON 可解析）；部署结果是否邮件通知（建议先记录与页面，邮件可选后续）。

2026-10-18（本机 CD 语义定稿：部署前需确认、保留健康检查、结果邮件通知）：所有者对 ADR 0004 的三点给出决定，方案定稿，实现留下一轮。

- **决定 1 推翻了全自动口径**：**安装任何新版本前必须有一次人工确认**，因此原设想的 `auto_deploy = true` 全自动安装**作废**，改为**每版本一次性部署批准**（记录谁/何时/理由/目标版本/产物 sha256）；未获批准的版本 worker **只报告不安装**。自动化只覆盖"检测 + 执行 + 验证 + 回执 + 回滚"，**决定永远由人做**。
- **决定 2**：保留健康检查（`<prefix>/current/bin/forgeloop serve --once --json` 退出码 0 且 JSON 可解析，可再加 `GET /api/service`）；不通过即自动回滚并记录两次版本，回滚失败停在明确状态。
- **决定 3**：部署结果（成功/回滚/失败）必须邮件通知，复用 best-effort 回执通道；发送失败只记 `mail_deliveries`，不影响部署结论。
- 实现方案已写入 ADR（记录层批准表、`domain/deploy.py` 判据补"未批准拒绝"、`deploy approve` 与回执、worker 只读检测与领取执行、页面"待确认部署"段、邮件通知、契约与文档同步），并给出通过/拒绝两侧测试矩阵与真机 C 组验收（成功部署+邮件、健康检查失败自动回滚、未确认不得安装）。

2026-10-18（本机 CD 真实试验跑通；两个真缺陷被真实试验抓出并修复）：所有者要求"完成真实试验"，本轮用**真 wheel、真前缀、真 CLI、真邮箱**跑完整链路，并据试验结果修缺陷。

- **真实试验做了什么（可复核）**：`uv build` 构建真 wheel（`forgeloop-0.0.1-py3-none-any.whl`，产物校验值 `ef3c009a…`）→ `deploy --bootstrap` 装入 `.cache/cd-experiment/prefix/releases/0.0.1` 并**原子激活** `current` → 运行**部署后的** `current/bin/forgeloop serve --once --json` 得到**合法 JSON**（schema_version/worker 段齐全）→ 部署结果**真实邮件通知已发送到 592260959@qq.com**。试验产物与日志留在 `.cache/cd-experiment/`（含 `deployments.jsonl`）。
- **缺陷 1（bootstrap 收尾崩溃）**：bootstrap 路径下 `health_detail` 未初始化，部署**已完成**但命令在最后一步抛 `UnboundLocalError`。已修（初始化 + 仅受控路径做严格健康检查），并补**回归断言**（bootstrap 成功后必须走到"邮件通知"那一步）。这条只有真实跑一次才会暴露——单元与场景测试都没覆盖到 bootstrap 收尾。
- **缺陷 2（邮件配置链误吞他人配置）**：主机上存在无关的 `~/.config/mail.toml`（含 enabled/from/inbound/outbound/to 等陌生键），旧候选顺序把它排在 **ForgeLoop 专用路径之前**，导致配置加载直接报"未知键"失败。已修两处：**专用路径 `~/.config/forgeloop/mail.toml` 优先**，通用路径只作兜底；且**非显式候选解析失败只跳过并记录**，逐个尝试，全部不可用才 fail-closed（`--config`／`FORGELOOP_MAIL_CONFIG` 仍失败即拒绝）。相关单元测试同步更新并新增顺序断言。
- **验证**：`make check` **exit 0（1733 项 + 前端 117）**。

2026-10-19（**常驻服务真机验收 A 组通过**，含 CD 部署链路；两个真实事故已修）：所有者在本机执行接入脚本，服务上线并逐条满足 A 组判据。

- **A 组实测证据（所有者宿主，systemd --user）**：
  - **A2 启用即运行**：`systemctl --user status forgeloop` → `active (running)`，Main PID 1305731，CGroup 指向 `releases/0.0.2/.venv/bin/forgeloop serve`（运行的是**新构建**，不是缺 `serve` 的旧产物）。
  - **A3 状态接口**：`curl localhost:8712/api/service` → JSON，含 worker 心跳（`running: true`、`polls: 42`、`last_poll_at` 实时、`last_error: ""`）与 `startup_checked_at`。
  - **A4 启动核对**：日志 `启动核对: 0 项需人工核对`（R4 的只读核对在真机生效）。
  - **A5 重启恢复**：`systemctl --user restart forgeloop && sleep 2 && is-active` → `active`。
  - 日志同时确认：`自动接续: 关闭（只报告，不推进）`（`auto_advance` 默认关闭的设计口径）、`页面写入口: 已启用（提交/批准/推进/验收/停止；仅本机 + 页面令牌 + 同源校验）`。
- **CD 链路真机跑通**：构建 0.0.2 → 部署（保留上一版本 0.0.1 供回滚）→ 原子激活 → **部署结果通知邮件已发出**（`592260959@qq.com` 收到两封：昨晚本地试验一封、今晨真机一封）。
- **两个真实事故（都由真机使用暴露，已修 + 提交）**：① 前缀里"已激活的 0.0.1"是**缺 `serve` 的旧构建**，脚本沿用后服务陷入重启循环 → 修法：**升版本号**（0.0.1→0.0.2，一个版本只对应一份产物，不绕过保护）+ 脚本加**启用前 `serve` 预检**（不通过则不启用）；② 脚本"已有激活版本就跳过部署"的条件没比较版本号 → 改为**仅同版本才跳过**，并加 `--no-unit` 供工作区内彩排（已彩排通过）。另修正脚本/文档里硬编码的示例端口 8765 → 按 `config/service.toml` 读实际端口。
- **待办（B/C 组）**：B 组（`kill -9` 后不盲目重放）需有执行中的任务现场；C 组（真实模型长跑）需先配置可执行项目（当前日志显示`可执行项目: 无`）并获模型开销授权。

2026-10-18（会话面板：页面右侧对话框面板 + 会话/运行时/项目三组端点，未提交）：按所有者要求「在前端页面右侧增加对话框面板，支持会话管理、Agent Runtime 管理、开发项目管理（支持对接多个代码仓/项目）、对话的开始、HITL、终止等基本操作」实施。开工前把两条范围口径交所有者选定：**A. 最小真实闭环**（新建会话记录 + 三组端点，对话用现有 PI 单轮调用，HITL = 显式「待人工决定」队列）与 **B. 面板可直接增删改项目**（写回配置文件）——所有者选定 A + B，因此本批不涉及流式事件、多轮上下文压缩与工具级审批（属 B21/B22 范围，需单独立项评审）。

- 计划范围与实际改动：新增 `src/forgeloop/domain/conversation.py`（会话状态、HITL 判定、提示词组装与输出解释纯规则）、`domain/projects.py`（面板项目档案校验、合并与确定性 TOML 序列化）、`domain/toml_fields.py`（与 `domain.service` 共用的字段校验原语）、`records/conversations.py`（`panel_sessions`／`panel_messages`／`panel_decisions` 三张表）、`graph/conversation.py`（一轮执行 `ConversationRunner` 与在跑轮次登记）、`cli/panel.py`（项目注册表、读模型与写分发）；修改 `cli/serve.py`（装配面板、两条读路由与写分发、启动前提校验、优雅停止时收起执行器并中止在跑轮次）、`domain/service.py`（新增 `[panel]` 配置：并发 1..8、单轮超时秒数；字段校验改为共享原语）、`config/service.toml`（`[panel]`）、新增 `config/projects.toml`（页面项目档案）、前端 `frontend/src/{payload,actions,panel,panel_render,page,app}.ts` 与 `src/forgeloop/cli/web_page.html`（右栏面板 + 两列布局）及随包产物、`frontend/{stryker.config.mjs,.dependency-cruiser.cjs,playwright.config.ts}`、`tests/fixtures/{fake_pi,seed_panel_e2e}.py`、`scripts/export_cli_contract.py`、两份契约快照、`docs/{architecture,engineering-reliability}.md`、`CONTEXT.md`、`README.md`。
- 实际行为：`GET /api/panel`（项目就绪 + 运行时占用 + 会话清单）与 `GET /api/panel/sessions/<id>`（消息与待人工决定）；写端点 `POST /api/panel/sessions`、`…/messages`（202 受理）、`…/terminate`、`…/decisions/<did>`（批准=可带指令立即重跑，拒绝=终止会话）与 `POST /api/panel/projects`、`…/<name>/update`、`…/<name>/remove`；全部经既有三道闸门（页面令牌、同源、请求体上限）。**一轮 = 一条人工消息驱动一次真实 PI 调用**：PI 仍以 `--no-session` 启动，历史（最近 20 条、上限 20000 字符，超出截断并标注）随提示词回放；`HOME` 指向项目档案的隔离目录、工作目录固定为项目路径；Agent 只有输出 `{"awaiting_human": true, "question": …}` 才登记「待人工决定」（不用自然语言猜测），一轮超时/协议错误/模型错误/无文本一律停在待人工决定，不自动重试；终止**先写终态再发 `abort`**，因此收尾那一轮无法把会话改回进行中（该判定在记录层，被并发终止时以终止为准）。项目档案：`config/service.toml` 的手写项目页面只读，页面项目写在 `config/projects.toml`（与手写项目同名即拒绝启动；页面增删改前校验路径存在与隔离 HOME 的模型配置）；仍有进行中会话的项目不允许删除。
- 验证结果（本批实测，全部 exit 0）：`make check`（高频 **1785 项通过**、3 跳过、5 未选；静态门禁与两份契约门禁通过；前端 jsdom **172 项**）；`make coverage`（高频＋集成 **2001 项通过**，行 **94.78%**、分支 **90.44%**、changed-lines 通过）；`make test-system`（**53 项**，含 10 项面板真实子进程用例）；`make frontend-e2e`（**9 项真实 Chromium**，含 3 项面板用例：项目/运行时可见与建会话、一轮真实 PI 回复 + HITL 批准往返、终止需理由且终止后隐藏输入区）；前端覆盖 `make frontend-coverage`（语句 **96.68%**、分支 **90.88%**、函数 **93.04%**、行 **97.21%**）；前端变异 `scripts/check_frontend_mutation.py` **OK：94.92%**（面板 `panel.ts` 94.19%，25 条等价幸存者逐条登记）。本批新增 Python 用例 **196 项**（unit 128、component 32、integration 26、system 10）与前端用例 55 项 jsdom + 3 项真实浏览器。
- 真实浏览器抓到一个快速层看不见的缺陷（这正是该层的理由）：`panel.ts` 原先写 `this.#fetcher(url, init)`，在 Chrome 里 `fetch` 的接收者变成面板实例，直接抛 `TypeError: Illegal invocation`（jsdom 与注入替身都不报错）；改为普通调用形式的 `#request` 后 e2e 转绿。另有一处用例自身的缺陷：假 PI 的 `chat-hitl-first` 状态文件跨用例残留，导致第三条浏览器用例拿不到「首轮请求人工决定」，已在用例里显式重置现场。
- 未验证（如实记录）：① **真实模型下的面板会话**未跑（集成与系统层用假 PI 覆盖协议与状态机；真实 PI 的会话轮次需模型开销授权）；② 多标签页／多浏览器同时操作同一会话的界面行为未验（服务端有并发与终态判定，页面按 1.5 秒轮询）；③ 面板**不覆盖**流式输出、多轮服务端上下文、工具级审批与压缩，属 B21/B22。
- 发现但不碰：① 本机主检出的另一会话在途改动里，`frontend/src/actions.ts` 的 4 条变异幸存者登记与源码行号漂移、另有 5 个等价幸存者未登记（其自身变异门禁会失败）——本批为让同一份报告可判定，按原原因原文平移了 4 条键并补登 5 条（原因逐条核对代码与既有用例后写入），另修正 `config/quality-policy.toml` 中已不再出现的过期条目；② `frontend/src/render.ts` 的 DOM 管线仍不纳入变异范围（与既有口径一致），`panel_render.ts` 同此处理；③ 既有页面 CSS 里 `--border`／`--danger` 只在规则中出现、从未定义（操作面板输入框边框与失败文案取不到颜色），本批因面板复用同一套样式而补齐定义，属同文件内的事实订正。

2026-10-19（`panel-session` 合入 main；合并提交见本轮结果，**未推送远端**）：按所有者指令把 `panel-session` 合入 main。合并在**独立工作树** `.cache/merge-panel`（从 `723f903` 起，分支 `panel-on-main`）里完成并跑齐门禁，未在另一会话的工作区里做任何冲突操作。
- **冲突面与解决口径**：`git merge-tree` 预演 77 处，实际合并冲突 **24 个文件**（根因：本分支是共享工作树的旧基线 `f1c676e` 快照，带着对方文件的旧版本）。口径是「凡我没实际改过的取 main，只有面板真正动过的才手工合」：① 5 个我从未修改的文件（`tests/unit/test_service_config.py`、`cli/main.py`、`frontend/src/actions.ts` 之外的 `docs/deployment.md`、两个 js 产物）直接取 main；② 40 处单边冲突块由脚本自动解决（只有一边有内容）；③ 面板相关文件手工合：`docs/architecture.md`（5 处，保留 main 的 `task_commits`／33 张表等新事实 + 面板模块行）、`docs/status.md`（两侧条目都留）、`README.md`／`CONTEXT.md`／`docs/engineering-reliability.md`／`config/service.toml`／`frontend/playwright.config.ts`／`stryker.config.mjs`／`page.ts`／`payload.ts`／`scripts/export_cli_contract.py`／`web_page.html` 取含面板的版本、`cli/serve.py`（6 处）与 `domain/service.py`（7 处）取「main 内容 + 面板接线」；④ 产物与契约重新生成（`make frontend-build`、`export_cli_contract.py`）。
- **合并中修掉的两处分歧**：① `frontend/src/actions.ts` 的 `successMessage` 在 main 上不再回退 `detail`，而面板写端点用 `detail` 报人读结果（例如「已受理，一轮执行在常驻进程内进行」）——保留 main 的实现并恢复这一条回退；② `domain/toml_fields.py` 的项目名文案多了一个空格（`项目名 必须…`），与 main 的「消息即契约」用例逐字断言不符（`test_service_config.py` 失败）——对齐为 `项目名必须…`，两侧用例同时通过。
- **验证（合并树 `.cache/merge-panel`）**：`make check` **1938 项 + 前端 184 项**、静态门禁与两份契约门禁全绿；`make test-system` **56 项**；`make frontend-e2e` **11 项真实 Chromium**；前端变异 **OK：94.72%**（检出 538／未检出 30；登记按**本次变异报告**重建——main 侧 `src/actions.ts` 的 9 条登记行号是旧的，与实际变异位置不符，直接把 main 的清单交给门槛会失败）。
- **`make coverage` 仍红，且已证明是 main 既有问题（非本次合并引入）**：合并树行 94.25%／分支 89.72%（2161 项通过），基线 `723f903`（未合并，独立工作树 `.cache/main-baseline` 实测）行 94.08%／分支 **89.72%** 同样低于 90% 分支门槛。两处数字一致，因此本次合并**没有降低**覆盖率；缺口集中在对方在途模块（`adapter/mail.py` 60%、`cli/deploy.py` 64%、`cli/release.py` 72%、`cli/serve.py` 78% 等），补测属其批次范围，本批次未动。
- **未做**：未推送远端（本地 main 与 `origin/main` 已分叉：本地领先对方未推送的 14+ 提交、落后远端 5 个提交，推送需先归并远端，属所有者决定）；未改动另一会话工作区里的 4 个未提交文件。

2026-10-19（同步与推送；提交 `4a99cc6` + `f5fae31`，分支 `panel-session`，**未合入 main**）：按所有者指令同步代码。分支 `panel-session` 已推送（`f5fae31`），远端 `main` 未动（仍 `04a2589`）；本机共享 `.git/config` 的 `origin` 远端在同步期间被外部操作丢失，因此本次按 URL 推送、**未改动共享配置**。提交内容与边界：`4a99cc6` 是共享工作树（`.cache/worktrees/panel`，基线 `f1c676e`）的完整快照，除本批次面板四项能力外还包含另一会话在途的常驻服务 R1–R4／部署／邮件／状态页 TypeScript 迁移等内容（其内容亦已在本地 main `723f903` 提交，归属以该批次为准，本提交不改写其结论）；`f5fae31` 只改钩子配置与一条新用例。
- **同步过程中抓到的缺陷（已修 + 已加机器守卫）**：`git push` 时 git 会向 pre-push 钩子导出 `GIT_DIR`／`GIT_INDEX_FILE` 等变量，钩子里的 pytest 把它们继承给测试进程，于是测试中为**临时仓库**启动的 git 子进程命中真实仓库。可复现证据：带 `GIT_DIR` 跑 `tests/scenario/test_self_iteration.py` 是 **21 失败／2 通过**，正常环境 **23/23 通过**；在钩子里整层跑出 **108 failed + 9 errors**，而同一命令在干净环境 **1825 通过**。破坏性后果：真实仓库的 HEAD 与索引被测试的 `checkout`／`reset` 改到别的提交上（本次实测两次：HEAD 被切到 `723f903`、索引只剩 3 个文件；**分支引用与提交对象未受损**，两次都用 `git checkout -f panel-session` 完整恢复并逐项核对内容）。修复：`fast-tests` 钩子改写为 `env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_PREFIX -u GIT_COMMON_DIR -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES .venv/bin/pytest …`，并新增 `tests/unit/test_hook_git_env.py` 把「跑 pytest 的钩子必须清掉这些变量」钉成机器判定（改配置即失败）。该缺陷与既有的「`.git/config` 被覆盖事故」同源：测试子进程带着真实仓库定位变量运行，任何改写 `.git` 下文件的测试路径都会作用到真实仓库。**未用 `--no-verify` 或任何绕过手段**，推送前钩子实跑：前端检查 Passed、高频测试 Passed。
- 未验证与保留项：① 修复只在本分支，尚未合入 main，其他工作树仍可能在推送时踩同一缺陷；② 测试侧未做「子进程自清 git 变量」的纵深加固（涉及多个测试文件，属另一批次范围），本次只在钩子层拦住；③ 本机共享 `.git/config` 的 `origin` 缺失仍未由本批次修复（属另一会话的事故恢复范围，本批次未触碰共享配置）。

2026-10-18（会话面板续批：流式输出、服务端多轮上下文、轮次边界工具审批、上下文压缩可见，未提交）：按所有者要求「先不合到主分支，继续实现流式输出、服务端多轮上下文、工具级审批、压缩」实施。开工前先用**本机 206 份真实 PI 轨迹（500 万+ 事件，`.cache/dogfood` 与 `.cache/preflight-sessions`）**核对协议事实，再定实现口径：
- 计划范围与实际改动：新增 `src/forgeloop/graph/session_runtime.py`（`SessionProcessPool`：一个会话一个常驻 PI 进程、空闲回收、按最近使用淘汰、运行时状态）；`domain/conversation.py` 增流式／工具／上下文编辑的**纯解释器**（`text_delta`、`tool_call_started/finished`、`context_edit_notice`、`tool_risk`、`approval_required`、`build_turn_prompt(continuation=)`）、`ToolRisk`／`ToolApprovalPolicy`／`DecisionKind.TOOL_REVIEW`、`MessageState.STREAMING`；`records/conversations.py` 增 `panel_tool_calls` 表、`panel_messages.context_mode` 与 `panel_sessions.compaction_count` 列（旧库自动补列）、流式消息的建行／更新、工具调用与压缩计数方法；`graph/conversation.py` 重写为「常驻进程 + 流式落库 + 工具留痕 + 轮次边界审批 + 压缩留痕」（`TurnStreamWriter`、`TurnRun`、`reap_idle_sessions`）；`adapter/pi_rpc.py` 增 `on_event` 增量回调与 `pid`／`is_alive`（不传回调时行为与以前完全一致，任务图不受影响）；`cli/{panel,serve}.py` 增工具调用与压缩字段、常驻会话与审批策略运行时字段、批准时放行待审工具；`domain/service.py` 与 `config/service.toml` 增 `[panel]` 的 `session_idle_seconds`／`max_live_sessions`／`tool_approval`（off/write/all，默认 write）；前端新增 `frontend/src/panel_tools.ts`（工具列表渲染，自 `panel_render.ts` 拆出）并改 `panel.ts`（**自适应轮询**：有轮次在跑、有会话排队或详情里有 streaming 消息时 600ms，否则 1500ms）、`panel_render.ts`、`payload.ts`、`web_page.html`（工具区与流式光标样式）、`tests/fixtures/fake_pi.py`（`panel-stream`／`panel-tools`／`panel-compact`／`panel-multi` 四种模式与增量间隔开关）、`tests/fixtures/seed_panel_e2e.py`（三个页面项目各带一种假 PI 模式）、`frontend/tests/e2e/panel.spec.ts`（流式增长与工具审批两条真实浏览器用例）、`docs/architecture.md` 与两份契约快照、`CONTEXT.md`（新增流式落库／轮次边界工具审批／上下文压缩词条并改写会话轮次与待人工决定）。
- 协议事实（本机轨迹核对，不引用外部文档）：① 流式增量真实存在——`message_update` 的 `assistantMessageEvent` 有 `text_start/delta/end`、`thinking_*`、`toolcall_*`；② 工具调用可逐次观察——`tool_execution_start`（`toolCallId`／`toolName`／`args`）与 `tool_execution_end`（`result`／`isError`／`durationMs`），实测工具名为 `bash`／`read`／`edit`／`write`；③ **没有任何执行前的工具审批事件或命令**——500 万+ 事件、1.5 万+ 次工具执行中零 permission/approval/confirm 事件，请求侧只见 `prompt`／`get_last_assistant_text`／`abort`；④ 压缩以 `entry_appended` 的 `entry.type == "context_edit"` 出现（882 次），无独立压缩事件；⑤ 多轮续接是协议设计的一部分（`agent_settled` 语义含「queued continuation」，真实请求日志单会话 1~19 次 prompt）。
- 因此**工具级审批只做协议允许的那一半**：逐次可见（名字、参数与结果摘要、风险级别、耗时、是否报错）+ 风险分级（只读／写文件／执行／未知按需确认）+ **轮次边界**的人工审批闸门（`tool_review`：批准=放行并继续，拒绝=终止）。**执行前阻塞式拦截标记为「未落实」**：RPC 协议无该事件或命令，审批文案如实写明「PI 在轮次内自行执行工具，本审批发生在轮次边界」。
- 验证结果（本批实测，全部 exit 0）：`make check`（**1825 项通过**、3 跳过、5 未选；静态门禁与两份契约门禁通过；前端 jsdom **184 项**）；`make coverage`（**2048 项通过**，行 **94.87%**、分支 **90.28%**、changed-lines 通过；前端语句 96.76%、分支 91.24%、函数 92.89%、行 97.40%）；`make test-system`（**56 项**，含新增 3 项：真实进程下的流式增长与落定、工具闸门 + 批准 + 常驻进程 pid 复用、压缩计数与系统消息）；`make frontend-e2e`（**11 项真实 Chromium**，含新增 2 项：整轮结束前文字在增长且结束后标记消失、工具逐次可见 + 轮次边界审批后可继续）；前端变异 `scripts/check_frontend_mutation.py` **OK：94.72%**（检出 538、未检出 30，30 条等价幸存者逐条登记）。本批新增 Python 用例 **49 项**（unit 40：执行器重写后 32 项中新增 13、领域解释器与续接提示词 25、工具调用身份与旧表迁移 2；integration 7；system 3）与前端用例 **12 项 jsdom**（4 项渲染 + 8 项自适应轮询）+ **2 项真实浏览器**（流式增长、工具审批往返）。
- 实现过程中测试抓到的真实缺陷（均已修）：① 流式已落库的助手文本被轮末**重复追加**一次（同一段话出现两遍）——改为「流式写过就不再补写，只有协议没给增量时才补」；② HITL 时把原始标记 JSON 留在流水里——改为把那一行改写成给人看的问题（原始 JSON 仍在 PI 事件文件里可回查）；③ 只读工具被记成 `approval_status=pending`，面板误标「待审批」——不需要确认的调用改记 `none`；④ 终止会关掉常驻进程，正在收尾的那一轮可能看到 EOF 而不是 abort 回执，被记成「执行失败」且因状态闸门静默丢弃——改为终止事实优先，统一留一条「本轮已被人工终止」；⑤ 批准的**自动重放**语义过宽（工具审批与 Agent 提问的批准也会重发上一条人工消息，可能重复执行同一批动作）——改为只有「上一轮失败」的批准才自动重试。
- 未验证（如实记录）：① **真实模型下同一常驻进程的第二轮是否确实看得见第一轮上下文未实测**——本机无 `pi` 二进制、bash 无外网，调度与状态机由假 PI 覆盖（轨迹证据支持「上下文是进程内账本」，但这是推断而非实测，且这一条要等真实模型运行才能关闭）；② 真实模型下的流式节奏、工具风险分级是否够用（例如 PI 后续新增工具名会落到「未知工具按需确认」）未验；③ 压缩后的目标／约束保留情况未核对（面板只如实转述 `context_edit`，不臆造摘要）。
- 真实试验（本机真实服务进程 + 四种假 PI 模式，证据 `.cache/manual-panel/run-log.txt`）：`forgeloop serve` 起在 127.0.0.1:8799，用真实 HTTP 依次驱动四项能力并逐秒记录——流式读数 6 次（4→8→12→12→16→19 字符，单调不减）、落定 `state=ok`；工具留痕 `bash`（execute／需确认／pending）与 `read`（read／none）、闸门 `tool_review` 文案含「轮次边界」；批准后 `bash:approved,read:none`、第二轮 pid 复用且冷启动仍为 1、上下文模式 `cold,warm`；压缩计数 1 + 系统消息且人工消息仍在；多轮会话第二轮回复「第 2 轮回复（本进程已服务 2 次）」且提示词不含第一问（`含『第一问』=False`）；终止后常驻进程被收起。
- **真实试验抓到的缺陷（已修 + 已补回归）**：`panel_tool_calls` 早期把 `tool_call_id` 当全局主键，而 PI 的 `toolCallId` 只在一次会话内唯一——两个会话各跑一次 `bash`（假 PI 都用 `call-bash-1`）时，后一条 `ON CONFLICT` 更新覆盖了前一条的会话归属，第二个会话的工具行在面板上「消失」（快速层的用例每个服务实例只建一个带工具的会话，因此没覆盖到）。改为复合主键 `(session_id, tool_call_id)`、结束事件按会话限定更新，并为旧现场补一次性重建迁移（幂等，按 pk 序号判形状）；回归用例：记录层两条（同名 id 两会话各留一行 + 旧表迁移不丢行）、集成层一条（同一服务实例内两个工具会话各记两行）。
- 发现但不碰：① `config/quality-policy.toml` 里 `panel.ts` 的 5 条类型守卫幸存者随源码行号平移（62→67、68→73），原因原文未改；另有 3 条新增等价幸存者（两个字段初值在首读前必被赋值覆盖、`clearTimeout(undefined)` 与 `await undefined` 是 no-op），逐条写明理由后登记；② 面板的**前端**没有展示 `live` 明细（只显示常驻会话数与每个会话的 pid 复用事实），完整明细在 `/api/panel` 的 `runtime.live` 里——按当前使用场景（单用户本机）不再加界面；③ 面板仍不覆盖 IDE 级工具拦截（需要 PI SDK 的 tool dispatch 包装，而非 RPC），属后续单独立项。

2026-10-19（取消需求：终态守卫与 CLI，撤下+留痕；两次环境事故已恢复）：所有者要求"支持删除需求"，按项目记录保留规则实现为**取消**。

- **语义**：取消 = 结束自动推进 + 人工决定留痕；身份、版本、批准、交付与现场**原样保留**（与"物理删除记录"区分，后者未获授权、不做）。
- **记录层**：`requirement_cancellations` 表（只追加、首条决定为准）+ 落库 API：需求必须存在，`--by`/`--reason` 缺失即 fail-closed 且零副作用；状态与决定同事务。
- **CLI**：`requirement cancel <req_id> --by --reason`（记录决定并打印；未知需求/空理由退出码 1）。
- **终态守卫**：`REQUIREMENT_TERMINAL_STATUSES` 纳入 `cancelled` —— 推进只做只读回查，**不得把 cancelled 覆盖成 executing**（与既有 accepted/rejected 同一条路径）。
- **测试**：记录层 3 项 + CLI 场景 4 项（成功取消后 status 显示 cancelled、空理由被拒、未知需求报错、取消后推进仍保持 cancelled）。
- **环境事故（如实记录，均非代码问题，内容完好）**：① `.git/config` 的 `core.bare` 两次被置真（`git log` 正常、`git status` 报"必须在一个工作区中运行"），全仓库搜索无任何代码/脚本会设置它，来源不明；② 由此连带一次索引异常——`git status` 显示 `.github/workflows/*`、`Makefile`、`AGENTS.md` 等一批跟踪文件"已暂存删除"，而**磁盘上文件都在**（逐项核对：4 个 workflow、Makefile、AGENTS.md 均在位）。用 `git reset`（只重置索引）恢复；此后提交改为**显式列出文件名**，不再用 `git add -A`；`git fsck` 仅两个悬空 blob（正常历史残留）。

2026-10-19（**所有者确认删除口径 + 取消提议接线完成**）：所有者明确"删除是取消+记录，不是物理删除"。

- **口径决定（已记档）**：删除 = **取消 + 记录**；不做物理删除。需求取消后进入终态 `cancelled`，身份、版本、批准、交付与现场**全部保留**，后续推进一律拦下（终态守卫）。
- **取消提议接线**：轮询结果标注 `cancel_requested`（适配层用 `domain.mail.requests_cancellation` 判定，正文可用处即判定），并透出到轮询文档条目的 `cancel_proposal` 字段；**只标注、不执行**——真正取消仍由人跑 `requirement cancel`（邮件是数据，不构成授权）。
- **测试**：场景测试 2 项（正文"请取消需求"→ `cancel_proposal: true`；"取消按钮的位置也请调整"→ `false`，不误判）；CLI 契约快照补字段并重导出。
- 途中修正：插入 `_entry` 返回字段时因同名字段出现两次而误插到 `mail confirm` 文档（作用域无该变量），已删除误插；lint/type/测试全部通过后提交。

2026-10-19（**邮件对话闭环：答复回流进需求**）：所有者要求"完成完整的邮件对话功能"。

- **闭环补齐**：同一线索的新入向邮件（`record_inbound` 返回"新登记"）会把**正文作为答复追加成需求修订版本**（`RequirementStore.append`），状态回到 `draft` 等待重新分析——答复不再是孤立的邮件记录，而是真的进入需求材料，下一轮分析可据此消歧。只追加不覆盖；已验收/已取消的**终态需求不接收回流**（只读）。
- **测试**：场景 2 项——对话中答复使需求版本 +1 且含"邮件答复"、状态回到 draft；终态需求不追加。
- **对话现已可往复**：邮件提需求 → 分析产生待澄清问题 → `mail confirm --questions` 发问 → 对方回信 → 答复回流 → 重新分析 → …（≤3 轮消歧上限仍生效）；批准/验收/取消仍需人工动作。
- **仍缺（下一步）**：① 出向回执带上**问题正文**（现在只有问题编号）；② `auto_analyze` 接线（收到即自动跑一次分析，免去手工 `requirement analyze`）；③ 页面"待确认取消提议/答复待分析"段。

2026-10-19（**auto_analyze 接线完成**，未落实项转为已实现）：所有者要求把 `auto_analyze` 真正接上。

- **行为**：`mail poll` 新增 `--auto-analyze/--no-auto-analyze`（三态，缺省取邮件配置 `auto_analyze`，默认关闭）与 `--pi-command/--project-path/--baseline/--pi-timeout-seconds`；轮询后对**本次新登记**入向邮件的需求各跑一次既有分析管线（approvals/槽位/工时规则不变），单条失败只记录不中断；缺 `--pi-command` 时明确提示"本次不分析"。
- **实现位置**：组合根 `main.cmd_mail_poll_with_analysis`（`cli/mail.py` 不能反向导入 `main`，避免环依赖），通过 `add_mail_parser(..., poll_entry=...)` 注入。
- **JSON 隔离**：`--json` 时文档独占 stdout，自动分析说明只走人类输出（此前会破坏 JSON 解析，被 18 个场景测试当场抓出）。
- **测试**：3 项（开启时对受影响需求调用一次、缺省不调用、缺 pi-command 时提示且不调用）。
- **模板**：`config/mail.example.toml` 补注释说明该开关的真实语义与前置条件。

2026-10-20（远端收敛尝试：合并到 main 中止，已回滚；分支已推送待评审）

- **背景**：所有者要求把本地 `main`（66 个提交）与远端 `main`（10 个提交，另一会话的状态页三页签、branch-protection 等）收敛。远端已有历史，直接 push 被拒（non-fast-forward）。
- **尝试**：按所有者选择启动逐文件合并，已合并 6 个核心冲突（`pyproject.toml` 注释并集、`cli/mail.py` 签名并集 `poll_entry` + 返回子命令表、`cli/main.py` 四处装配并集、`cli/requirements.py` 取对方 retry 更新、`cli/web.py` 并集、`web_page.html` 取对方结构）。
- **中止原因**：对方前端把动作 UI 重构到别处，我基于旧结构的 `cancel` 补丁点消失；冲突面共 **22 个文件/约 60 处**，继续盲改有丢掉对方在途功能的风险（项目规则要求保留他人改动）。已 `git merge --abort` + `reset --hard` 回到 `27560f3`，工作树仅剩对方 `docs/branch-protection.md`，测试复跑通过。
- **已交付的收敛通路**：本地工作已推送为远端分支 `entry-parity-2026-10-20`，可用 PR 评审合并（不覆盖远端 main 历史）。
- **未完成**：正式合并到 `main` 需要一次专门的文件级合并（尤其前端动作 UI 重构后的接入点），或由所有者在 PR 中解决冲突。
2026-10-19（邮箱交互入口 B02 需求级，未提交）：按所有者要求把邮箱提升为与 CLI 同源的交互入口，新增 `forgeloop mail interact --once`：白名单发件人可提交新需求，或回复既有通知执行 `status`／`revise`／`analyze`／`plan`／`approve <任务包版本>`／`advance`／`accept`／`help`；结果与当前状态随回信返回，命令、批准与执行复用同一套 `RequirementStore`／`graph`／`RecordStore` 记录。

- 计划范围：新增 `src/forgeloop/domain/mail_interaction.py`、`src/forgeloop/records/mail_interactions.py`、`src/forgeloop/cli/mail_interaction.py` 与三份分层测试；修改 `src/forgeloop/adapter/mail.py`（RFC 2047 头部解码、`Auto-Submitted` 保留、`send_reply`）、`src/forgeloop/cli/mail.py`（返回 `mail` 子解析器供同组追加交互命令）、`src/forgeloop/cli/main.py`（注册 `mail interact`）、`scripts/export_cli_contract.py`、`contracts/cli-contract.json`、`contracts/architecture.json`、`docs/architecture.md`、`docs/product-requirements.md`、`docs/pending-requirements.md`、`README.md`、`CONTEXT.md` 与本文件。
- 实际行为：`mail interact --once` 认证 IMAP、拉取未读、按固定命令词确定性解析；非白名单发件人与 `Auto-Submitted` 自动回复不建档、不回信、不执行；新邮件受理并回信需求编号与下一步；回复按出向 Message-ID（`In-Reply-To`／`References`）、主题或正文中的 `req-…` 关联需求。批准必须显式写出任务包版本，并与最新任务包及需求版本绑定；自然语言「同意」只按需求修订追加，绝不产生批准。入向 Message-ID 先占位再执行，重复轮询不重复建档、批准或推进；回信先落入库再发送，发送失败保留 `action_done` 且下次只重发同一封回信；进程中断留下的 `executing` 现场标记 `uncertain` 并回信说明，不自动重放。`analyze`／`plan`／`advance` 在轮询内同步执行，未配置 `--pi-command` 时只回复配置缺失。
- 契约与架构：`contracts/cli-contract.json` 新增 `mail_interact_command`／`mail_interact_exit_codes`／`mail_interact_document`；`contracts/architecture.json` 新增三个模块（`cli.mail_interaction`、`domain.mail_interaction`、`records.mail_interactions`），`layer_edges` 不变；`docs/architecture.md` 第 1、3、6、7 节同批更新（含 `mail_interactions` 表与记录总数 29 张）。
- 验证结果：新模块与相关用例 **186 项通过**（unit／component／scenario／integration 的邮件相关用例；含真实本地 socket 的 IMAP/SMTP 集成 24 项）；`make test-system` **20 项通过**；`ruff check`／`ruff format --check` 全仓通过；`pyright` 全仓 0 errors＋1 条既有 warning；`make cli-contract-check`／`make architecture-contract-check` 均 exit 0（快照已含并行重构的 `project` 契约与模块）；`make import-lint`／`make deptry`／`make structure-metrics` exit 0（0 失败、383 条审阅提示，含本批与并行重构新增代码）；本次新增测试 **112 项**。覆盖率（仅邮件相关用例）：`cli/mail_interaction.py` 92%、`domain/mail_interaction.py` 100%、`records/mail_interactions.py` 100%、`adapter/mail.py` 新增分支由集成用例覆盖。
- **全量门禁已通过（2026-10-19 14:1x 最终复跑）**：`make check` **exit 0**——**1661 项通过、3 项真实模型用例未启用跳过、5 项未选**，前端 **68 项通过**，lint／format／本地 AST／pyright（0 errors＋1 条既有 warning）／CLI 契约／架构契约／提交策略配置／结构报告（0 失败、383 条审阅提示）／import-linter／deptry 全绿。原始日志 `/tmp/forgeloop-mail-check6.log`（更早的同组合运行 `check3`／`check4` 分别 1658／1660 项通过）。**一次 flaky 如实记录**：中间一次 `make check` 因 Hypothesis 截止时间判 flaky 失败（`tests/property/test_requirement_retry_property.py::test_cli_blank_reason_never_drives_resume` 首跑 302.81ms > 200ms 截止），单跑该用例通过（13.45s），复跑整套转绿；该用例与本批改动无关。过程如实记录：本批次验证期间同一工作区另一执行方正在落地多项目记录根重构（`domain/project.py`、`records/projects.py`、`cli/projects.py`、`cli/common.py`、`cli/main.py` 等），`make check` 先后因该重构的 `ruff`、`pyright`、`cli-contract-check`、`architecture-contract-check` 失败（11:5x 的一次全量 pytest 为 1567 通过／201 失败）；该重构随后完成并自行修复、重导契约快照与架构文档，复跑转绿。本批次的 `mail interact` 按该重构的 `records_root`／`project_for` 接口使用项目记录根并在测试中登记临时项目；并行改动未被本批次覆盖或回退，既有 `mail poll|confirm` 分类工作流也随该重构定位到项目记录根并通过全量用例。
- 覆盖率门禁（2026-10-19 14:1x，`make coverage`）**未通过**：门槛脚本报行 **94.62%**（达到 90%）、分支 **88.89%**（低于 90%）、增量覆盖 **86%**（低于 90%）。增量失败集中在并行多项目重构的 `cli/requirements.py`（78.1%）、`cli/merge.py`（87.5%）、`cli/web.py`（87.5%）等文件；本批邮件模块为 `cli/mail_interaction.py` 92%、`domain/mail_interaction.py` 100%、`records/mail_interactions.py` 100%，`adapter/mail.py` 新增分支由集成用例覆盖。未修改并行重构的代码，因此**不声称覆盖率门禁通过**；原始日志 `/tmp/forgeloop-mail-coverage-full2.log`（13:5x 的前一次同结论运行见 `/tmp/forgeloop-mail-coverage-full.log`）。
- 提交（2026-10-19 18:04 +0800）：`d1c76cf`（`feat(mail): 邮箱交互入口与真实邮箱验证`），**75 文件、+6992/−634**；提交前 `.venv/bin/python scripts/check_commit_policy.py --check-now` 放行（`outside_work_hours`，18:00 后进入合法窗口），`make check` exit 0（1661 通过、3 跳过、5 未选，前端 68 项通过），pre-commit／commit-msg hooks 通过（时间策略、Ruff、Pyright、Conventional Commit 头）。按所有者 2026-10-19 的选择，该提交同时纳入并行执行方未提交的多项目记录根重构，提交说明已如实注明其来源。**未 push**：`main` 领先 `origin/main` 1 个提交。环境修复（如实记录，非本批功能改动）：本机 `.git/hooks/pre-commit`／`commit-msg` 仍指向迁移前旧 checkout 的 venv，首次提交报 `pre-commit not found`；按 `make hooks` 重新安装（`PRE_COMMIT_HOME` 指向工作区 `.cache/pre-commit`）后提交通过，未修改提交策略、未使用 `--no-verify`。本文件对该提交的哈希记录随后作为独立文档提交落库。
- 未验证（如实记录）：**真实邮箱已验证**（QQ 邮箱 IMAP/SMTP 与真实人工回复，见下条「真实邮箱验证」），但**未在真实 cron 下运行**；`analyze`／`plan`／`advance` 的真实 PI 邮件驱动未执行（只测了接线与假结果）；DKIM/SPF/DMARC 密码学来源校验未实现，当前依赖发件地址白名单与邮箱服务商认证；任务级验收／追加授权命令与主动进度通知未实现；`domain/mail_interaction.py` 未纳入 `mutmut` 清单，未实测变异幸存者（`pyproject.toml` 已记录暂不纳入的原因）。
- 发现但不碰：① 既有 `mail poll`／`mail confirm` 分类工作流已随并行多项目重构适配（`mail confirm` 改为按需求定位项目记录根），全量用例通过；当前两套邮件工作流并存——分类建议需人工确认后才发信，交互入口 `mail interact` 自动回信，后续若要合并入口需单独评审。② 本批次只做需求级交互，任务级验收（`approve <task_id> --stage acceptance`）仍需 CLI，邮件入口的“同等”范围如实限定在需求级。③ 真实邮箱服务商行为已用真实账户核对，见下条「真实邮箱验证」；仍未核对的是真实自动回复与退信样本。④ `src/forgeloop/cli/mail_interaction.py` 已 **1046 物理行**（超 1000 审阅上限），`_process_unlinked`／`_handle_existing` 触发结构审阅提示；判断为同一交互入口的状态汇总、命令编排与回信幂等，当前不按数字拆文件。⑤ 结构报告 383 条审阅提示中含本批与并行重构新文件的数量／复杂度提示，均为审阅项而非门禁失败。⑥ 极端窗口：新需求已写入 `requirements` 但回写 `mail_interactions.req_id` 前进程退出时，会留下未被邮件线程关联的需求；下次轮询只回「不确定、未自动重放」，不猜测关联，需人工按创建时间核对。已通过「先占位再执行」把重复建档与重复批准挡住，但需求记录与交互账分属两次写入，无法在同一事务内完成。
- 真实邮箱验证（2026-10-19 下午，所有者要求）：账号与授权码取自本机 `~/.config/forgeloop/mail-secret`（未入库、未打印、未写入任何记录），使用 QQ 邮箱 `437336207@qq.com`（IMAP `imap.qq.com:993`、SMTP `smtp.qq.com:465`）与专用文件夹 `其他文件夹/FORGE_INBOX`；记录根为一次性临时项目 `.cache/real-mail-test`（`.cache/` 已被仓库忽略）。测试邮件未删除，仅在结束后恢复为已读。
  - 第 1 轮（受理）：用真实 IMAP `APPEND` 注入 1 封未读测试邮件 `<fl-real-test-1-20261019@forgeloop.local>`（QQ 会把 `APPEND` 默认标为已读，需显式清除 `\Seen`）。真实 CLI `python -m forgeloop mail interact --once` 结果 `fetched=1 processed=1 replied=1`，创建需求 `req-20261019043422-5e1c10` 并真实投递回信；在 Sent Messages 取回实际邮件：主题 `[ForgeLoop][req-20261019043422-5e1c10][已受理]`，`In-Reply-To`／`References` 为注入邮件 Message-ID，正文含需求编号、下一步与状态。
  - 第 2 轮（状态查询）：注入 `status` 回复后再跑一次，`fetched=2 processed=1 replied=1 skipped=1`：第 1 封按入向 Message-ID 幂等跳过，第 2 封关联到同一需求并投递 `[状态]` 回信。
  - 第 3 轮（真实人工回复）：所有者 12:34 从个人地址 `592260959@qq.com` 回复 `help`。白名单最初只有系统邮箱地址，该邮件被正确判为 `authorized=false` 并跳过；把所有者地址加入 `--allowed-sender` 后重跑，`fetched=3 processed=1 replied=1 skipped=2`，命令解析、需求关联与回信均成功；Sent 中取回收件人为 `592260959@qq.com`、主题 `[ForgeLoop][req-20261019043422-5e1c10][帮助]`、`In-Reply-To` 为该人工回复 Message-ID 的真实回信。
  - 记录核验：临时项目 1 条需求、1 个版本、0 条批准、3 条 `mail_interactions`（submit／status／help，全部 `completed`）、3 条入向记录。清理后 `FORGE_INBOX` 的 UNSEEN 归零，再次运行确认 `fetched=0`。
  - 真实发现 A（重要）：QQ 重写出向 `Message-ID`——我方存储的 `<forgeloop-…@forgeloop.local>` 实际投递为 `<tencent_…@qq.com>`，人工回复的 `In-Reply-To` 因此不会命中 `mail_interactions.reply_message_id`；本次线程关联实际由主题中的 `req-…`（`parse_reply_reference` 回退）完成。主题被客户端改写时关联会失败；服务端不保证提供最终 Message-ID，后续可评估按已投递主题／引用链建索引。
  - 真实发现 B（重要）：白名单必须包含**实际发件人**地址；只登记系统邮箱地址会把所有者的真实指令静默跳过（行为 fail-closed 正确，但部署时要登记全部常用发件地址）。
  - 真实发现 C：QQ `APPEND` 默认把新邮件标为已读，测试注入必须显式 `UID STORE -FLAGS (\Seen)`；真实外部来信通常未读，这不是产品缺陷。
  - 真实发现 D：QQ IMAP 在短时间内多次连接后出现过 TLS 握手 `TimeoutError`；产品路径由 `MailConnectionError` 如实上报（既有行为），本次未单独构造该失败用例。
  - 真实发现 E（据此修复）：QQ 纯文本引用块用「原始邮件」引出、不用 `>` 前缀；已在 `domain.mail_interaction` 增加引用分隔识别（「原始邮件」「On … wrote:」），避免把历史引用追加进需求修订，并补了 unit 用例。所有者本次实际回复首行为 `help`，命令解析未受影响。
  - 未观察到：真实自动回复／退信样本（`Auto-Submitted` 过滤仍只有测试覆盖）、真实 DKIM/SPF 结果、真实 cron 与真实 PI 邮件驱动。

2026-10-19（多项目隔离与 git worktree，未提交）：按所有者要求把 ForgeLoop 从单一记录根扩展为多代码仓/多项目隔离。新增项目线 `forgeloop project add|list|show|update|migrate`：每个项目有稳定身份与独立记录根 `<records-root>/projects/<project_id>/`，需求、任务、检查点、会话、worktree 与提交都在项目内，项目之间不共享；工作副本从项目 bare 镜像 `repo.git` 用 `git worktree add --detach` 建立，源仓库不再作为 worktree 宿主。

- 计划范围：新增 `src/forgeloop/domain/project.py`（项目身份/显示名/路径纯规则与记录根形状）、`src/forgeloop/records/projects.py`（`projects.sqlite` 登记、跨项目唯一定位、`migrate_legacy` 迁移）、`src/forgeloop/cli/projects.py`（`project` 命令）；修改 `adapter/git_workspace.py`（bare 镜像 + worktree + 每 worktree `forgeloop-baseline` + `remove_workspace`）、`graph/nodes.py`（`NodeContext.repository`）、`cli/common.py`（项目根解析与定位）、`cli/main.py`、`cli/requirements.py`、`cli/merge.py`、`cli/release.py`、`cli/candidate.py`、`cli/deploy.py`（跨项目按标签查找，`--project` 消歧）、`cli/web.py`（跨项目聚合与 `--project` 过滤）、`cli/mail.py`（`mail confirm` 按需求身份定位项目根）、`scripts/export_cli_contract.py`、`contracts/architecture.json`、`contracts/cli-contract.json`、`docs/architecture.md`、`README.md`、`CONTEXT.md`、`frontend/src/payload.ts` 与随包编译产物，以及各层测试。
- 隔离语义（实际行为）：`--records-root` 是**登记根**，业务根固定为 `projects/<project_id>/`；带 `--project` 的命令直接取项目根，只带任务/需求身份的命令在全部已登记项目中唯一定位（零命中或跨项目重复都确定性失败）。根目录不再有业务 `records.sqlite`；旧根目录记录必须经 `project add` + `project migrate` 迁入，旧库出现多个项目身份即整体拒绝。
- 工作副本与 main 保护：项目登记建立 `git clone --bare` 镜像并删除 `origin`，每次新建任务现场以显式源路径 fetch 到 `refs/forgeloop/source/*`，再用 `git worktree add --detach <现场> <基线>` 建立；源仓库不出现 worktree 登记，跑完后 `worktree list` 与 refs 不变。批准基线写在该 worktree 私有 gitdir 的 `forgeloop-baseline` 文件，而不是镜像共享引用，同项目并发任务互不覆盖；旧 clone 副本仍可读 `refs/forgeloop/baseline`。
- 契约与文档：`contracts/architecture.json` 新增 3 个模块（`cli.projects`、`domain.project`、`records.projects`），`layer_edges` 不变；`contracts/cli-contract.json` 新增 `project_list_document`/`project_show_document`，`web_progress_document` 增加 `projects` 段、问题项增加 `project`、计数增加 `projects`；`docs/architecture.md` 第 1、3、5、6、7 节同批更新。
- 验证结果：`make check` **exit 0**（Python 快速层 **1661 项通过**、3 项未启用真实模型跳过、5 项未选；前端 **68 项通过**；Pyright 0 errors＋1 条既有 warning；CLI 契约与架构契约一致；结构报告 0 失败；lint/format/import-lint/deptry/前端静态门禁全部通过）。`make test-system` **20 项通过**；`tests/integration -m "not install"` **143 项通过、5 项 pi_live 跳过**；`make frontend-e2e` **4 项真实浏览器用例通过**（含跨项目状态页的真实记录 → 服务端 → 编译产物 → DOM）。本批次新增分层测试 **31 项**（unit 21、component 7、integration 3），并适配既有用例到多项目记录根与 worktree 语义。
- 未验证（如实记录）：未执行真实旧记录迁移演练（本机仓库根 `records.sqlite` 为 0 任务/0 需求，未迁移）；`--project-path` 在 `requirement advance|retry|dispatch` 仍作为覆盖项，项目未登记时回退到任务配置快照（`project update` 前不会强制一致）；容器隔离仍未接入；**未创建 commit**（所有者未要求提交）。
- 发现但不碰：① 邮件分类工作流 `mail confirm` 仍无 `--project`，本批次改为按需求身份定位项目根，未新增项目过滤参数；② `deploy` 按标签跨项目查找发布回执，同名标签在多个项目出现时必须 `--project` 消歧；③ 根目录 `records.sqlite` 为空但未删除，按迁移命令处理；④ `docs/product-requirements.md` 的「配置文件登记首期两个项目」现由项目登记表实现，未改写该需求文档措辞。
- 本条取代同日邮箱交互条目中「混合工作区全量门禁未通过」的临时记录：并行重构落定后，快速层、系统层与集成层门禁均已实际通过（数字见上）。

2026-10-19（Agent Runtime：DSH 接入与热切换，未提交）：按所有者要求新增 DSH（`dsh --profile headless --json`）作为第二个 Agent Runtime，与 PI 同属可插拔执行器；`forgeloop runtime set` 写权威运行状态，**每个动作启动前**重新解析，因此切换对下一个动作生效、无需重启推进进程，正在运行的会话不被打断。

- 计划范围：新增 `src/forgeloop/domain/agent_runtime.py`、`records/agent_runtimes.py`、`adapter/agent_runtime.py`、`adapter/dsh_headless.py`、`graph/agent_execution.py`、`cli/runtime.py`、`tests/fixtures/fake_dsh.py`、五份分层测试（domain／records／adapter／component／scenario）与 [ADR 0003](adr/0003-agent-runtime-hot-switch.md)；修改 `adapter/pi_rpc.py`（收敛到共同契约与共用行读取器）、`graph/nodes.py`／`graph/planning.py`（动作前解析运行时、证据落盘）、`graph/builder.py`（`pi_command` 可缺省）、`records/checkpoints.py`（识别新旧中断前缀）、`cli/main.py`／`cli/requirements.py`（`--pi-command` 可省略、`runtime` 命令、运行时不可用时失败关闭）、`scripts/export_cli_contract.py`、`docs/architecture.md`、`contracts/architecture.json`、`contracts/cli-contract.json`、`docs/pending-requirements.md`（B21 部分落实）、`CONTEXT.md`、`README.md`、`pyproject.toml` 与 `config/quality-policy.toml`（变异范围与 18 条幸存者审阅）、本文件。
- 实际行为（已实现）：
  - `forgeloop runtime show|set|list`：`set` 必填 `--by`/`--reason`，未知运行时、非法命令、空白身份或理由一律 fail-closed 且零副作用；每次 `set` 追加切换审计（谁/何时/从哪到哪/命令/理由）；`show --json` 给出当前选择、生效解析、进程环境覆盖与历史（进入 CLI 契约快照）。
  - 选择优先级：`FORGELOOP_AGENT_RUNTIME` > 记录层运行状态 > 默认 `pi`；命令优先级：显式参数 > PI 任务配置快照 > 运行状态同名命令 > DSH 官方默认。PI 没有内建默认命令：缺命令在动作启动前 fail-closed，不静默猜。
  - DSH 归类：只有 `turn_end.reason.kind=completed`（且有 `final`）与 `aborted` 记为 settled；provider `error` 记 `model_error`；`blocked`/`max-tokens`/`interrupted`/`forked`、运行器 `error` 事件、缺 `final`、非 JSON 行与超时按“未取得结果”中断（`agent_dev_unsettled:`／`agent_review_unsettled:`）。
  - 兼容性：默认仍是 PI，既有任务配置／批准／检查点语义不变；`records.checkpoints` 继续识别旧检查点的 `pi_*_unsettled` 原因，旧现场可就地续跑。
  - 证据：会话请求日志、`dev-reports.jsonl`、`reviews.jsonl` 与 `runtime` 查询都记录运行时身份与命令来源。
- 验证结果：`make check` **exit 0**（1619 通过、4 跳过、5 未选；前端 68 项通过；lint/format/typecheck／CLI 契约／架构契约／提交策略配置／import-linter／deptry 全通过；结构报告 0 失败 / 357 条审阅提示）；`make coverage` **exit 0**（1753 通过、9 跳过；行 95.57%、分支 90.15%、增量通过）；`make test-system` **20 项通过**；`tests/integration` **134 项通过、5 项 pi_live 跳过**；`make mutation` **通过**（1082/1242 杀死、160 幸存全部有审阅记录）。原始日志：`/tmp/fl-runtime-check.log`、`/tmp/fl-runtime-coverage.log`、`/tmp/fl-runtime-system.log`、`/tmp/fl-runtime-integration.log`。
- 热切换的真实证据（不依赖模型）：场景用例在**同一进程内**先由 PI（假 PI 子进程）实现、`runtime set` 切到 DSH 后由假 DSH 子进程完成审查，两侧会话请求分别标注 `pi` 与 `dsh`；另有 CLI 全链路（提交→批准→DSH 实现→DSH 审查→真实测试命令→验收→交付）与 DSH 驱动的分析与规划用例。
- 未验证（如实记录）：
  - **没有用真实 DSH／真实模型跑过一次会话**（**同日补充已实测并覆盖本项**，见下）：全部 DSH 用例使用 `tests/fixtures/fake_dsh.py`（按官方 0.2.1 事件流契约编写）；本机 `dsh 0.2.1-rc.2` 在 DSH 沙箱内因 `~/.dsh` 写权限被拒，仅用隔离 `DSH_HOME` 核对过 `--profile headless --help` 与 `--json` 选项存在，未执行真实任务，也未验证凭据、工具权限与真实 `turn_end` 文本。
  - **DSH 会话恢复未实现**：`--session-id` 续跑未接入，跨运行时会话不可互换；切换只发生在动作边界。
  - **容器 + DSH 未验证**：`runtime/Dockerfile` 只装 PI，容器模式下 DSH 命令需要镜像自带 `dsh`；host 模式仍是提示词级只读约束，不构成文件系统边界。
  - 真实 PI 回归（`pi_live`）本次未启用（需真实模型成本）。
- 一处真实失败与修复（变异门禁）：首次 `make mutation` 对新增模块报 **25 个未审阅幸存者**；逐项核对后 **7 个行为型变异补测试杀死**（JSON 字符串载荷不得按字符拆分、非序列值失败关闭、`runtime`/`runtime_source` 字段分支、字符串命令按 JSON 解析），其余 **18 个判为等价变异**（错误消息文本、`label` 默认值、`typing.cast` 首参、`list(command)` 规范化）并逐条登记理由；重跑模块与门槛脚本通过。过程见[可靠性方案第 30 节](engineering-reliability.md)。
- 发现但不碰：① `src/forgeloop/cli/main.py` 增至 **1100** 物理行，本批只新增运行时命令注册与失败关闭分支（拆分建议见既有状态记录）；② `runtime` 命令当前是**记录根级**（`scope=default`）单一选择，多项目/多范围选择未实现，需要时再按真实场景扩；③ `adapter` 仍是 `if` 分支而非可注册插件体系（第三执行器出现前不抽象）；④ 前端未改动。
- 架构同步：新增 6 个模块（`domain.agent_runtime` 叶子、`records.agent_runtimes`、`adapter.agent_runtime`／`adapter.dsh_headless`、`graph.agent_execution`、`cli.runtime`），跨层边未新增（`contracts/architecture.json` 仅多 6 条 `modules`，`layer_edges` 仍 9 条）；`adapter` 新增两条同层依赖（两个实现 → 共同契约）；`records.sqlite` 新增 2 张表（共 30 张）；会话请求记录新增运行时身份字段。`docs/architecture.md` 第 1、2、3、4、5、6、7 节与两份契约快照同批更新。
- 此次**未创建任何 commit**（所有者未要求）；改动在独立 git worktree `.cache/worktrees/agent-runtime`（分支 `feat/agent-runtime-hot-switch`）内，主工作区在途改动未触碰。

2026-10-19 同日补充（**真实 DSH／真实模型端到端验证**，未提交）：把上面的“未验证”逐项补成实测。全部使用本机真实 `dsh 0.2.1-rc.2`、真实模型（`deepseek-v4.1-flash`）与本机已安装的 `pi 1.1.0`；DSH 用工作区内 `DSH_HOME` + `--patch` 覆盖启用已保存凭据（headless 默认禁用凭据存储）。

- **真实 DSH 最小调用**：`dsh --profile headless --patch <overlay> --json` 返回标准事件流（`session` → `status` → `text` → `step_end(usage)` → `turn_end(completed)` → `final`），exit 0，8,961 tokens，stderr 空。核对到官方契约里的全部关键字段。
- **真实单任务闭环（DSH 实现＋DSH 审查＋真实测试＋人工验收）**：任务 `task-20261019043110-4bef68`（项目 dsh-live）→ **delivered**。实现会话 44 个事件、7 次工具调用（bash／glob／read／write）、63,514 tokens；审查会话 46 个事件、10 次工具调用、79,189 tokens，返回合法结构化 `blocking_issues: []`；正式测试命令真实执行 exit 0；候选 diff 只含 `hello.py`；工时 32.8s。**源仓库工作树干净、README 未被改写**，改动只出现在任务副本内。审查模型在总结里如实说明“本机沙箱不可用导致验收命令未能实际执行”——这正是“候选 diff 来自 git、正式测试由框架跑”的分工。
- **同一推进进程内真实热切换**：任务 `task-20261019043756-454cc2` 的 `approve` 进程启动后 2 秒（dev 会话已开始、由 DSH 执行），另一进程执行 `runtime set pi`；**同一个** `approve` 进程随后的审查动作使用真实 PI（`pi --mode rpc --no-session --provider cc-switch-open-code-go --model deepseek-v4.1-flash`）。证据：dev 请求记录 `agent_runtime=dsh`、review 请求记录 `agent_runtime=pi`、`dev-reports.jsonl` 为 dsh、`reviews.jsonl` 为 pi、测试 exit 0、任务 **delivered**；切换审计里能看到 `dsh → pi` 的时间与理由。另有 `task-20261019043341-0e1290`（square，全 DSH 实现＋审查）同样 delivered。
- **真实需求线（分析与规划，只读）**：`requirement analyze` 由真实 DSH 完成（8.6s，10,491 tokens，`agent_runtime=dsh`，零工具调用），产出可审阅目标且无待澄清项；`requirement plan` 同样由真实 DSH 完成（11.5s，12,316 tokens），产出 3 个带依赖的任务包并通过 `domain.repo_facts` 的路径／命令校验；任务包已由所有者批准（`plan-approval:req-…:v1:owner`），**未执行 `advance`**（真实自我迭代执行留待明确授权）。需求 `req-20261019054436-0083fa`（项目 req-live）。
- **真实 PI 回归**：`FORGELOOP_PI_LIVE=1 .venv/bin/pytest tests/integration/test_pi_live.py` **5/5 通过**（11.15s，真实模型），此前只在本机装 DSH 沙箱外运行过。
- **把真实路径固化为可选测试**：新增 `tests/integration/test_dsh_live.py`（marker `dsh_live`，`FORGELOOP_DSH_LIVE=1` 才运行；`FORGELOOP_DSH_HOME`／`FORGELOOP_DSH_COMMAND` 提供现场）与 `make dsh-live`；实跑 **2/2 通过**（9.35s），第二个用例验证真实模型在工作目录内真实调用工具创建文件。默认 CI／`make check`／`make coverage` 下该层跳过，不产生模型费用。
- **一次真实失败与归因（如实记录）**：首次真实运行把 `--patch` 写在 `--json` 之后，DSH 启动器把 `--json` 之后的参数交给应用，应用报 `unknown option '--patch'`；适配器把该 `error` 事件转成 `runtime-error: unknown option '--patch'` 并按未取得结果中断（任务 interrupted、零候选写入）。修正为启动器参数在前（`--profile headless --patch <overlay> --json`）后通过；该失败现场与事件原文保留在首个任务记录里。
- 仍未验证：DSH `--session-id` 会话恢复、容器内 DSH、以及真实模型的**长任务**（本批均为最小任务）；`make mutation` 的结论不受本补充影响（`pi_rpc` 不在变异范围）。

2026-10-19（Agent Runtime 分支合入 main，合并提交 `3f89058`）：`feat/agent-runtime-hot-switch`（`1273e6f`）已合入 main；与同期多项目隔离、邮箱交互批次（`d1c76cf`、`89ec274`）合并时做了以下适配与修复：

- **运行状态按项目隔离**：`forgeloop runtime show|set|list` 必填 `--project`，状态落在 `<records-root>/projects/<project_id>/records.sqlite`（与需求、任务、会话同一记录根）；`runtime show --json` 增 `project` 字段并同步 CLI 契约快照。本文件上一批次里“`runtime` 是记录根级（`scope=default`）单一选择”的描述据此更正为按项目隔离。
- **合并修复（对方批次遗留）**：`tests/project_support.py` 未登记进 `domain.repo_facts.TEST_ROOT_FILES`，合并后 `test_every_tracked_path_is_legal` 失败；已在合法清单登记并同步 `tests/unit/test_planning_repo_facts.py` 的固定事实断言。`cli/main.py`、`cli/requirements.py`、`graph/nodes.py` 同时保留项目登记/定位与 Agent Runtime 解析（`NodeContext` 同时携带 `repository` 与 `records_root`）。
- **覆盖率修复**：合并后分支覆盖率一度 **88.88%**（低于 90% 门槛，由两批新增代码的未覆盖分支叠加）；补邮件适配器边界（配置校验、解析辅助、IMAP/SMTP 失败分支）、DSH 生命周期与协议边界、runtime 文本输出与 `cli.common` 定位边界用例后，最终 1953 通过、9 跳过，**行 95.44%、分支 90.28%**、增量通过。
- **合入门禁**：`make check` **exit 0**（1810 通过、3 跳过、5 未选；前端 68 项通过；结构 0 失败 / 417 条审阅提示）；`make test-system` **20 项通过**；`make coverage` **exit 0**；合并提交与分支提交的本地 hooks（lint／format／pyright／提交时段／Conventional Commit）全部通过。
- **合入方式**：`git merge --no-ff`，合并提交 `3f89058` 的两父提交为 `1273e6f` 与 `89ec274`；合入前对方批次已提交、工作树干净，未覆盖、未回退、未 stash 任何在途改动。**未推送 `origin/main`**（需所有者另行授权）；推送前需注意规则集 `main-protection` 的签名与必需检查要求。
- **合入后变异复核（一次真实失败与处理）**：首次 `make mutation` 在基线收集阶段失败——`mutants/` 是 2026-10-17 的生成副本（当时仓库仍发布 `config/commit-policy.toml`），mutmut 检测到非 Python 文件变化后选择保留缓存结果，导致副本内 `test_repository_ships_only_a_template` 失败；**不是本次合并代码的问题**。删除可重建的 `mutants/` 副本后复跑：`make mutation` **通过**，1083/1242 杀死、159 幸存全部有审阅记录、no tests／skipped／suspicious／timeout 为 0。同时清理一条过期审阅条目（`counting.xǁGrantLedgerǁrecord_failure__mutmut_8` 现已不再幸存，`counting.py` 源码未变、系测试选择变化所致），清理后门槛脚本无提示通过。原始证据：`mutants/mutmut-cicd-stats.json`。

2026-10-19（状态页三页签分支合入 main，合并提交 `3df845a`）：`feat/web-tabs-layout`（`f965c89`）已合入 main。

- **合入方式**：`git merge --no-ff`，合并提交 `3df845a` 的两父提交为 `8780844` 与 `f965c89`；合入前分支相对 main 落后 1 个提交，`git merge-tree --write-tree` 预演无冲突、实际合入无冲突。未删除 worktree 与分支（`.cache/worktrees/web-tabs` 保留）。
- **内容**：状态页按需求／任务／问题三页签组织，按身份关联（`single_task_id`、`ref_id`）并支持跨段跳转、深链与 `hashchange`；需求卡片与任务分组可折叠且重绘后保留状态；各段补充描述；随包产物与跨语言契约测试同批更新。
- **合入后验证（独立复跑）**：`make check` **exit 0**（**1813 通过、3 跳过、5 未选**；前端 **144 项通过**；lint／format／pyright／契约／结构 0 失败、421 条审阅提示）；`make frontend-mutation` **通过**（击杀率 **97.31%**，检出 325／未检出 9、登记幸存者 8 条）；`make frontend-e2e` **11 项通过**（真实 Chromium）。原始日志：`/tmp/forgeloop-postmerge-check4.log`、`/tmp/forgeloop-fe-mutation.log`、`/tmp/forgeloop-fe-e2e.log`。
- **过程中的真实失败与处理**：首次合入后 `make check` 因本地 `reports/frontend-mutation.json` 是旧代码生成的陈旧报告而失败（登记的 `format.ts` 幸存者行号随代码移动），重新执行 `make frontend-mutation` 生成当前报告后转为通过；另一次失败是 Hypothesis 截止时间 flaky（`test_requirement_retry_property.py::test_cli_blank_reason_never_drives_resume`，单跑 13.49s 通过），均非合并代码缺陷。
- **推送状态**：`origin/main` 先由另一执行方推到 `8780844`（包含邮箱交互批次 `d1c76cf`／`89ec274`）；所有者 2026-10-19 授权后，本会话把本地 `main` push 到远端，`8780844..6ed4f03` 成功，`origin/main=6ed4f03`，GitHub API 校验合并提交与状态记录为 `verified=true, reason=valid`。

2026-10-19（环境事故：仓库 `.git/config` 被外部进程覆盖，已恢复，未提交代码改动）：约 19:46–19:48 发现主工作区 `git status` 报 `fatal: this operation must be run in a work tree`，`git worktree list` 把主仓库标为 `(bare)`。检查 `.git/config` 发现被改写为 `core.bare = true`、`user.name = Tester`、`user.email = tester@example.test`，且 `[remote "origin"]` 与 `branch.main` 的上游配置丢失；对象库、索引、引用与工作树文件未受影响（`git fsck --connectivity-only` exit 0，仅有 dangling 对象；`origin/main` 与本地提交均在）。

- **恢复动作（只改 `.git/config`，未改任何受跟踪文件）**：`core.bare=false`；重建 `remote.origin.url=https://github.com/Lijiajin95/ForgeLoop.git` 与 `remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*`；`git branch --set-upstream-to=origin/main main`；删除被写入的本地 `user.name`／`user.email`，回落到全局身份 `lijiajin`／`lijiajin9528@gmail.com`。恢复后 `git status` 正常、`main...origin/main` 同步。
- **事实核对**：`Tester`／`tester@example.test` 字符串来自 `tests/component/test_commit_policy_audit.py` 的 `init_repository()`（`git init -q` 后写入该身份）；但该文件 fixtures 使用 `tmp_path`，静态检查未见指向真实仓库的路径。`core.bare=true` 与在已有仓库目录内执行 `git init --bare` 的效果一致；**具体触发者未能从现有证据确定**（沙箱禁止 `ps`，无法核对当时进程）。
- **发现但不碰**：需要后续排查是否有测试或命令会在真实仓库根执行 `git init --bare` 或 `git config`，并加防呆（例如拒绝在已含 `.git` 的目录初始化裸仓库、测试统一用临时目录）。本批次不改相关测试与实现。



2026-10-20（本地 main 与远端 main 收敛：冲突逐文件合并，独立工作树验证通过；提交待授权）

- **背景**：所有者要求“解决项目当前修改和远端修改的冲突，合并到 main”。上一轮（`8173eda` 记录）在逐文件合并 6 处核心冲突后中止并回滚；本次在独立工作树 `.cache/worktrees/merge-origin`（分支 `merge-origin-scratch`，合并基点 `f1c676e`）完成整份合并，未在其它会话的工作区里做冲突操作。
- **两侧规模**：本地领先 67 个提交（三入口等价、常驻服务 R1–R4 与页面写入口、会话面板、取消需求、受控部署与部署批准、邮件白名单／自动回信／自动分析），远端领先 10 个提交（`mail interact` 邮箱交互、多项目记录根与项目 bare 镜像／worktree、Agent Runtime 热切换、状态页三页签、`.git/config` 事故记录）。
- **冲突面与解决口径**：`git merge` 报 **23 个文件 / 61 处冲突块**。① 代码取并集并按合并后的语义对齐：`cli/main.py`（`serve` 与 `mail interact` 两组入口并列装配、`mail poll` 入口注入 `poll_entry`、停止/批准保留审计列）、`cli/mail.py`（`add_mail_parser` 同时返回子命令表与接收 `poll_entry`）、`cli/requirements.py`（`retry` 同时保留 `--node` 与可省略的 `--pi-command`）、`cli/web.py`（项目归属 + 未核对动作问题项）、`adapter/pi_rpc.py`（`on_event` 与运行时共用的导入并集）。② 前端合并到“三页签 + 卡片/折叠/跳转（远端）”与“操作面板 + 会话面板（本地）”并存的布局：`render.ts` 取远端三段渲染并补操作面板渲染，`dom.ts` 的页面句柄补上操作面板元素，`page.ts` 同时接页签与操作面板；`web_page.html` 收敛为一份结构（本地版本此前整块重复，同一批 id 出现两次）。③ 契约与随包产物不手工改：`contracts/cli-contract.json`、`contracts/architecture.json` 重新导出，`static/*.js` 用 `check_frontend_build.py --update` 重建；`docs/architecture.md` 的模块表与表数按合并后源码实测重写（业务记录 **38 张表**）。
- **合并中修掉的真实缺陷（合并引入或两侧语义冲突）**：① `requirement cancel` 仍按旧单记录根解析（`NameError: records_root`），改为按需求身份定位项目根；② `cli/deploy.py` 的 `_store` 助手在合并中丢失（`deploy-approve`／`deploy` 直接 NameError），恢复为按 `--project`／唯一已登记项目定位，`deploy-approve` 补 `--project`，bootstrap 路径不再读批准；③ 邮件操作分派把**项目记录根**传给了既有命令（它们按 `--records-root` 再定位项目），改为传登记根、只有 `current_task_thread_id` 用项目根；④ 前端测试夹具的 `sampleProject` 与进度侧同名函数冲突，进度侧改名 `sampleProgressProject`；⑤ 本地新增测试（三入口等价、取消、邮件分派、统一事实读取器）沿用旧单记录根约定，改为 `project_support` 登记项目并读项目记录根。
- **常驻服务与多项目的口径（所有者 2026-10-20 指令“一个服务进程服务一个项目”，本批实现）**：本地 `serve`／worker／面板建于单一记录根，远端把业务记录移到 `projects/<project_id>/`，两者必须显式对齐。口径为**一个服务进程服务一个项目**：新增 `serve --project`（缺省取唯一已登记项目，多个项目不指定即拒绝启动），worker、会话面板库、页面写入口与部署结论都作用于该项目记录根；只读页面仍按登记根跨项目聚合并按服务项目过滤；`GET /api/service` 增 `project` 与 `project_records_root` 字段。多项目聚合（一个进程服务多个代码仓）未做，列为后续方案项——这是方向性选择，已如实记录，不声称已交付。
- **验证结果（合并树，全部实测）**：`pytest tests/unit tests/property tests/component tests/scenario` **2269 通过、3 跳过、6 未选**；`tests/system` **56 通过**；`tests/integration` **241 通过、8 跳过**（真实模型与安装类用例按既有约定未启用）；前端 Vitest **260 通过**，`tsc`／Prettier／ESLint（3 条审阅提示，0 错误）／dependency-cruiser／knip／产物漂移／门槛同源校验全绿；`check_frontend_mutation.py` **OK：95.65%**（检出 659、未检出 30，30 条幸存者逐条登记，其中 3 条按本次报告更新行号）；`ruff check`／`ruff format --check` 全仓通过；`pyright` **0 errors + 1 条既有 warning**；CLI 契约与架构契约 `--check` 通过；`lint-imports` 2/2、`deptry` 无问题、结构报告 **0 失败**。
- **提交与推送**：所有者 2026-10-20 指令“取消本机的提交禁止策略”后，生效配置移出为 `.cache/forgeloop/commit-policy.toml.disabled-2026-10-20`（两处生效位置都不再有配置，判定 `policy_absent`、提交时间禁止 **NOT enforced**；这不是“临时放宽”，领域规则、hooks 与 CI 审计保持不变，重新启用只需把模板复制回原路径）。本轮在该前提下创建合并提交（父提交 `8173eda` 与 `04a2589`）并推送 `origin/main`；未使用 `--no-verify`、未改时钟。提交身份按远端历史与签名密钥恢复为 `lijiajin <lijiajin9528@gmail.com>`（仓库本地配置里的 `Tester <tester@example.test>` 是已记录的 `.git/config` 事故注入；已推送到 `entry-parity-2026-10-20` 的历史提交不改写）。
- **未做（如实记录）**：真实浏览器端到端（`make frontend-e2e` 需要 Chromium 与真实服务，本轮未跑）、Python 变异（`make mutation`，夜间层）、真实模型用例（`pi_live` 需模型开销授权）。
- **发现但不碰**：① `cli/serve.py`、`cli/panel.py`、`graph/worker.py` 仍是单项目模型，页面与常驻的“多项目一个进程”需要单独方案；② `frontend/src/page.ts`（520 行）与 `render.ts`（542 行）超 500 行审阅阈值，属审阅提示、未拆；③ 本地 `web_page.html` 的结构块重复是本轮之前就存在的缺陷，本次合并时收敛，未另开修复批次。

2026-10-20（合并推送 origin/main 与 CI 结果；覆盖率分支门槛红为合并继承的既有缺口）

- **推送**：`04a2589..4c97e13 main -> main`（合并提交 `4c97e13`，父提交 `8173eda` 与 `04a2589`，作者/提交者 `lijiajin <lijiajin9528@gmail.com>`，本地 SSH 签名 Good）。推送前的 pre-push 钩子实跑：Ruff、Ruff format、Pyright、前端门禁、高频测试全部通过；`main` 已设置跟踪 `origin/main`，`git rev-list --left-right --count main...origin/main` 为 0/0。
- **远端规则集事实**：推送时 GitHub 返回 `Bypassed rule violations for refs/heads/main: Commits must have verified signatures（68 个提交）`。即 `main-protection` 的 `required_signatures` 仍然启用，但账号侧未把本机签名公钥登记为 Signing Key（所有者 2026-10-18 已取消该登记要求），因此这些提交显示 Unverified，由所有者 bypass 放行。这是该组合的已记录后果，不是本轮新增门禁，也未修改任何规则集。
- **CI（run 39411783236）**：`commit-policy` **成功**（提交头与时间审计通过）、`security` **成功**；`quality` **失败**，唯一失败点是覆盖率门槛——`check_coverage_thresholds.py` 报行 **94.02%**、**分支 89.47% 低于 90%**、changed-lines 通过；同一步测试 **2509 通过、12 跳过**（真实模型、容器镜像与 `reports/` 类用例按既有约定跳过）。因覆盖率检查先于 e2e 中止，该作业未执行到真实浏览器用例。
- **覆盖率归因（如实）**：合并前本地 main 的覆盖率报告（2026-10-18，`reports/coverage.json`）为行 93.83%、分支 **90.34%**；远端分支自身批次曾记录分支 88.89%（当时已如实标注未达门槛）。本次合并把远端新增模块（`mail_interaction`、`projects`、`agent_runtime`、`context` 等）与本地新代码合在一起，分支覆盖率落在 **89.47%**，因此**低于门槛**。这是合并继承的既有缺口，不是合并改坏了既有代码；本次未通过放宽门槛、跳过检查或改写报告来“修复”。
- **本机提交策略**：按所有者 2026-10-20 指令取消提交时间禁止，生效配置移出为 `.cache/forgeloop/commit-policy.toml.disabled-2026-10-20`（两处生效位置均无配置），判定 `policy_absent`、NOT enforced；模板、领域规则、hooks 与 CI 的 `commit-policy` 作业保持不变。提交与推送全程未使用 `--no-verify`、未改时钟。
- **未做（需另立批次或授权）**：① 补测把分支覆盖率恢复到 ≥90%（候选缺口：`mail/config.py` 87%、`domain/toml_fields.py` 88%、`cli/serve.py` 与 `records/projects.py` 的新增分支）；② 在本地复跑 `make frontend-e2e`（CI 因覆盖率提前中止未执行到该步）；③ Python 变异（`make mutation`，夜间层）；④ 一个进程聚合多个项目的常驻服务（本轮按所有者指令取“一个进程服务一个项目”，聚合列为后续方案）。

2026-10-20（CI/CD 修复：恢复覆盖率门禁、变异沙箱可运行、修掉 CD 的多项目与相对路径缺陷）

- **CI 红点（Engineering quality）**：合并后唯一失败点是分支覆盖率 89.47% < 90%。按“补测而不是放宽门槛”处理：新增 `tests/unit/test_serve_project_scope.py`（`_served_project` 的显式／唯一／多项目／旧名／未登记五个分支、`ServeSettings.records_root` 与 `project_id`、`_resolve_settings` 的 web 项目过滤与 `--project`、`deploy_section` 的无发布／待批准／已批准、服务文档的 `project` 字段与进展过滤、部署批准归属 `_approval_root` 的 fail-closed 分支、`service_text`／`_emit`／停止钩子的两种形态、记录根绝对化）与 `tests/unit/test_deploy_prefix.py`（相对／`~` 前缀绝对化、激活链接必须是绝对目标）。复跑：**分支 90.22%、行 94.34%、changed-lines 通过**。未修改任何门槛数值。
- **前端 e2e 重新跑通（18/18）**，并抓出两处合并遗留缺陷：① `tests/fixtures/seed_serve_operations_e2e.py` 仍写旧单根记录，改项目登记 + 项目记录根（否则 `/api/progress` 为空、页面无可操作对象）；② **相对 `--records-root` 会让任务停在 `implementing`**——任务现场是 `git worktree` 派生路径、PI 与测试命令在各自 cwd 执行，相对根被两处解析成不同目录（实测两次对照：相对卡住、绝对到验收门）。修复在 `cli.common.base_records_root`：统一 `expanduser().resolve()`，所有命令共用同一口径。
- **部署前缀缺陷**：`deploy --prefix <相对路径>` 安装成功但激活链接写成相对目标，按链接所在目录再解析一次 → 冒烟 127「未找到可执行文件」（实测）。修复：`_prefix` 绝对化 + `activate` 写绝对链接目标；相对与绝对前缀各实测一次，均完成安装→激活→冒烟。版本号 `0.0.3 → 0.0.4`（`pyproject.toml` + `uv.lock`）：一个版本只对应一份产物，本轮改动需要新产物才能交付。
- **CD 工作流（`deploy.yml`）多项目化**：新增 `project`（缺省 `forgeloop`）与 `records-root`（缺省本机登记根）输入，前缀可由仓库变量 `FORGELOOP_DEPLOY_PREFIX` 覆盖；安装前两项只读前置（本机 CLI 支持 `--project`、项目已登记）失败即退出且不安装；`deploy` 被拒时把发布回执与 `deploy-approve` 的补办命令一起打印。仍不代做批准：缺回执或缺该版本一次性批准时 fail-closed，人必须在记录根上批准。
- **本机现场**：登记根 `.forgeloop` 由旧单根迁到项目布局（旧库当时为空，`project add forgeloop` + `project migrate` 如实提示“未迁移的目录: projects”）；`serve --once --json` 在真实记录根上显示 `project: forgeloop`、`project_records_root: …/projects/forgeloop`，`deploy` 段为“没有已发布版本”。`0.0.4` wheel 在**工作区彩排前缀**完成构建→安装→激活→冒烟（不触碰真实前缀）。
- **夜间变异（已转绿）**：先修结构缺口——mutmut 副本不拷贝点文件，`tests/unit/test_hook_git_env.py` 在基线收集阶段直接失败；`[tool.mutmut].also_copy` 纳入 `.pre-commit-config.yaml` 后基线可跑。合并后的树起初有 **105 个未审阅幸存者**，逐个复核后分两类处理，**没有整批登记等价**：
  1. **真缺测试 → 补行为测试（新增 `tests/unit/test_panel_settings.py`，36 个用例）**：`resolve_panel_settings` 此前没有任何单元测试（页面会话并发/单轮超时/常驻进程/工具审批的护栏只被端到端默认值间接跑过），70 个变异体因此存活；补测覆盖默认值、逐字段上下界、类型、未知键与大小写键名、以及 `resolve_service_settings` 的透传与错误传播。
  2. **逐条核对为等价/文案变异后才登记（+22 条，含 8 条 `cast(...)` 实参、`DeployOffer` 默认 `False` 实参、空版本号时 `parse_version("v")` 仍为 `None`，以及消息文本/短 SHA 位数）**；同时删掉 15 条已不再幸存的过期登记。另把 `deploy_offer` 已批准分支的 `tag`/`version`/`reason` 与 `panel.tool_approval` 的完整消息断言补上（4 个字段级变异体因此被杀死）。
  最终：**1520/1698 杀死、178 个幸存者全部有审阅依据**，`make mutation` 通过（`178 reviewed`）。
- **真实前缀交付（本批完成）**：经所有者授权的一次性沙箱放宽后，`scripts/install_local_service.sh --no-unit` 在**真实前缀**完成构建→安装→激活→冒烟：`current -> releases/0.0.4`（产物校验值 `1dc1858f…d5dd`，上一版本 0.0.3 保留可回滚，部署日志已写、通知邮件已发）；`systemctl --user restart forgeloop` 后单元 `active`，`/api/service` 返回 `project: forgeloop`、`active_version: 0.0.4`、`operations_enabled: true`，`/api/progress` 返回 `projects: [forgeloop]`、页面 200。即常驻服务现运行合并后的 0.0.4。
- **CI 与 CD 的实测回执**：`main` 的 `41aa030` 跑 `Engineering quality` **三个作业全绿**（quality / security / commit-policy；quality 内含静态门禁、覆盖率、系统层与真实浏览器 e2e），见 run `39422717570`。CD 工作流首次在自托管 runner 上真实执行（run `39423751574`，手动 `workflow_dispatch -f tag=v0.0.4`）：预检通过（激活指针 `releases/0.0.4`、CLI 支持 `--project`、项目已登记），随后被权威判据拒绝——`FAIL: 缺少 v0.0.4 的发布回执；未发布的版本不部署`，并把两项补办命令原样打印；作业按 fail-closed 退出 1，未安装任何东西。这条与上一轮的“跑不起来/装错记录根”是本质区别。
- **标签与 Release 清理（所有者要求，2026-10-20）**：删除两个已并入 `main` 的归档标签（`archive/task-20261014101006-7f8664` → `64f3685`、`archive/task-20261014130149-27caec` → `5240022`，`git cherry main` 均为 `-`）与过时的 `v0.0.1` GitHub Release（含 `forgeloop-0.0.1-py3-none-any.whl` 与 `SHA256SUMS`，下载数 0）及其同名标签。现状：本地与远端**均无标签**，远端只剩 `main`；本机部署日志（0.0.1/0.0.2/0.0.3 bootstrap、0.0.4 激活）不受影响。后续 `release` 会创建新标签与新 Release。
- **未完成（如实记录）**：① 一次**成功**的 `release → deploy` 自升级——需要一次真实交付产生的已验收产物（S1 规则不允许在标签工作流重建产物），本轮验证到“工作流真实可达 + 授权门禁 fail-closed + 部署器/manifest 与真实前缀安装”；② 单任务在真实模型下的推进未在本轮复跑（假 PI 验收，模型调用需授权）。

### 实现范围

| 层 | 内容 |
| --- | --- |
| domain | 失败轮次计数与累计、追加授权额度、批准绑定任务身份与方案版本、执行时间限额、提交时间策略、受控归并规则、受控发布规则、受控部署与回滚规则；需求身份与版本、只读分析校验、任务包与批准绑定、候选产物身份；状态页刷新间隔与问题分类纯规则；邮箱命令解析、发件人白名单、自动回复过滤与回信主题纯规则；项目身份、显示名、仓库路径与记录根形状纯规则 |
| records | 项目登记 `projects.sqlite`（身份、显示名、仓库路径、默认分支、迁移前旧名）与按项目隔离的业务记录（每项目 `projects/<id>/records.sqlite`：任务 13 张表、需求 8 张表、邮件线索 3 张表＋邮箱交互 1 张表） |
| adapter | PI RPC（JSONL 帧、命令/响应 id 关联、abort、模型错误如实上报）、正式测试命令运行器、项目 bare 镜像与 `git worktree` 任务现场、发布标签、本机部署（下载 Release 资产、独立版本环境、原子切换、冒烟检查、部署日志）、IMAP 轮询与 SMTP 发送（RFC 2047 头部解码、线程回信、`Auto-Submitted` 保留） |
| graph | LangGraph 两次批准（方案／验收）、失败回边、追加授权；独立审查 fail-closed（结果非结构化即中断，不判为“无阻断”）；需求线只读分析与按依赖推进，`RequirementTaskRunner` 把需求任务映射到单任务图 |
| cli | `project add|list|show|update|migrate`（多项目登记与旧记录迁移）；`submit` / `approve` / `grant` / `status --json` / `stop`；`requirement submit|revise|analyze|plan|approve|advance|accept|status`；`merge` / `release` / `deploy` / `rollback` / `candidate <task_id>`；`web`（B01 只读状态页，`GET /api/progress`，跨项目聚合与 `--project` 过滤）；`mail poll|confirm`（分类工作流）与 `mail interact`（需求级交互入口） |
| 前端（TypeScript） | `frontend/src` 的页面行为代码（纯规则／渲染／轮询／装配分层），编译为随包模块 `src/forgeloop/cli/static/*.js`；门禁：ESLint、Prettier、tsc、dependency-cruiser、knip、Vitest（覆盖 90%）、Playwright（真实 Chromium）、Stryker（夜间）、npm audit |
| 需求研发线（A，I01 接通） | `requirement submit` → 分析（可澄清）→ `plan` 任务包 → `approve` 批准 → `advance` 按依赖推进单任务图 → 全部任务交付后 `accept` 整体验收；需求追加版本使旧任务包与旧批准失效 |
| 邮箱交互（B02 需求级） | `mail interact --once`：白名单发件人提交需求，或回复通知执行 `status`／`revise`／`analyze`／`plan`／`approve <版本>`／`advance`／`accept`／`help`；结果与状态回信；命令按入向 Message-ID 幂等，批准绑定最新任务包版本 |
| 自迭代链路 | submit → 批准 → PI 副本实现 → 独立审查 → 副本内真实测试 → 人工验收 → `merge`（绑定验收基线、漂移拒绝、推送 GitHub） |
| CD 受控发布（S1） | `release` 创建 annotated tag 并按需推送 → Release 工作流从标签构建一次产物并附 `SHA256SUMS` → 发布回执固化标签／归并提交／基线／候选 diff 校验值；同标签重复发布幂等、换标签拒绝；Release 创建后**显式派发 Deploy**（2026-10-13 接通） |
| CD 受控部署（S2） | `deploy` 只部署 Release 上同一份产物（校验值不匹配即拒绝，禁止重新构建）→ 独立版本目录 `releases/<version>` → 原子切换 `current` → 冒烟检查 → 部署日志；`rollback` 只切到已安装且留有校验记录的版本 |

### CD 进展（P1）

| 段 | 状态 |
| --- | --- |
| S1 受控发布 | 代码与门槛已落地（`forgeloop release`、`releases` 表、发布回执、Release 工作流、CLI 契约含 release 节）；场景测试覆盖发布／同标签幂等／换标签拒绝／未归并拒绝；**尚无真实标签**——首个发布要等真实任务归并后、由所有者指定版本号执行 |
| S2 本机部署 | 代码与门槛已落地（`deploy` / `rollback`、部署日志、deploy 工作流）；**本机已完成一次真实引导部署**（`v0.0.1`，来源 bootstrap，校验值 `ab03c198…c4e`，冒烟 exit 0，独立 venv Python 3.13.5）；触发链路断点已修复（显式 `workflow_dispatch`，2026-10-13），但「Release → 自托管 runner → 部署」真实端到端与真实两版本回滚**仍未执行**（见[部署说明](deployment.md)） |
| S3 CI 合入门槛 | **方案 B 已实现并已推送**（`0f4aa3b`）：`forgeloop merge` 有远程时默认走"候选分支 → 匿名等必需检查 → 快进 main → 删候选分支"，失败/超时保持 main 不动并保留分支，证据写入 `merge-evidence.json`（本地真实 git + 假检查状态已实测）；**ruleset 仍未设置**，需所有者按[分支保护方案](branch-protection.md)在网页执行（Evaluate → Active） |

### 验证数字（本次批次代码状态，2026-10-13 实测；逐行标注来源）

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| `make check` | **九项静态门禁**（lint、format、typecheck、test、cli-contract-check、commit-policy-config、structure-metrics、import-lint、deptry）＋高频测试；pylint 已退出门禁（两项检查并入结构报告） | 见下两行与[可靠性方案第 25 节](engineering-reliability.md) |
| `make check`（门槛精简批次，最终运行；树指纹 HEAD `0ae92ca`） | exit 0：446 项通过、5 项 deselected；结构 **0 失败 / 70 条审阅提示**（含复杂度 18、参数 5、分支 5） | 本机 macOS 实跑 `.cache/reliability-review/check-final4.log` |
| `make check`（中途一次运行） | exit 2：`typecheck` 在 `tests/unit/test_nodes.py:456/475` 报 2 个 Pyright 错误——同一工作区另一会话在途测试文件（随后在其提交中修正）；当时逐个单独运行静态门禁全部 exit 0，Pyright 对本次改动文件 0 错误 | `.cache/reliability-review/check-final2.log`、`gates-isolated.log`；原始失败保留，未以复跑替换 |
| 测试 | 快速套件 446 项通过；含集成 464 项通过、5 项 pi_live 显式跳过；系统层 2 项通过 | 本机 macOS 实跑（本次批次改动后） |
| 覆盖率（高频层，排除真实安装） | 行 94.81%、分支 90.06%，门槛（90%）通过；diff-cover 增量对 `origin/main` 通过 | `.cache/reliability-review/coverage-final3.log`；同一晚 21:1x 首跑曾 exit 1（行 93.29%、分支 85.23%），归因于另一会话在途的 `graph/evidence.py`，原始失败与归因保留在第 25 节 |
| 真实安装层（低频） | `make test-install`：5 项（19.8–78.8s/项，预算 180s）；夜间作业 `install-tests` | 见可靠性方案第 22.1 节（实测分类）；本次未重跑 |
| 变异 | 门槛通过：**557/652 杀死、95 幸存（95 条全部审阅）、0 未完成状态**；本次未重跑全量变异，只跑脚本层测试 17 项 | [可靠性方案第 23 节](engineering-reliability.md)；判定口径变化见第 25 节 |
| 测试选择清单 | 旧 CI 并集（高频 446 ＋ 带覆盖 469 ＋ 系统 2）与新 CI 并集（带覆盖 469 ＋ 系统 2）**0 差异**：原有用例全部仍执行，仅不再重复 | `.cache/reliability-review/selection/` |
| CLI 契约 | `contracts/cli-contract.json` 快照一致（`status --json` 文档含 merge／release 嵌套节与交付 `candidate_sha256`；I02 追加 `requirement status --json`），受控漂移负例可拒绝 | `make cli-contract-check` |
| 部署现场 | `~/.local/share/forgeloop`：`releases/0.0.1` + `current` 指针 + `deployments.jsonl`；`~/.local/bin/forgeloop` 指向 current；已安装 CLI 独立 venv（Python 3.13.5） | 本机真实引导部署（2026-10-13 08:10） |
| SAST | 2026-10-13 为 Semgrep 4 条规则、35 个目标、0 findings（含 release/deploy 工作流）；**2026-10-16 起改为 Ruff S 子集（7 条 bandit 代码）+ `scripts/check_untrusted_deserialization.py` 本地 AST 检查，`make sast` 已移除**（见上文与可靠性方案第 27 节） | 原 `make sast` 本地实跑；替换后随 `make lint` 在 `make check` 内执行 |
| 部署守卫（真实前缀） | 同版本不同产物被拒：已激活 `ab03c19885c7` vs 待部署 `986a885b4821`，exit 1，已安装版本与部署日志未变 | 本机实测（2026-10-13 09:2x，`~/.local/share/forgeloop`） |
| pi_live | 5/5 通过（真实 PI RPC＋真实模型 `cc-switch-open-code-go/deepseek-v4.1-flash`） | Debian 本机实测（`reports/local-pi-live.log`）；证据探针取得真实文本 `ok`、stderr 空（`.cache/pi-live-evidence/sessions/`） |
| 真实 CI（本批次） | **未运行**：本批次未提交、未推送；CI 命令组合已在本地按同一目标实跑 `make check-static coverage test-system` exit 0（`.cache/reliability-review/ci-command-local.log`），失败传播实测为静态门禁失败即非零退出并中止 | `.github/workflows/quality.yml` 改动待真实 CI 首次运行 |

### 验证数字（I01／I02 批次，2026-10-14 实测）

环境：本机 macOS ARM64，CPython 3.13.15（uv 托管），基线 HEAD `0a391ff` + 本批次工作树。日志在 `.cache/i02/`。

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| 正式测试（本任务验收命令） | `pytest -q tests/unit tests/property`：**519 项通过** | 本机实跑 |
| `make check` | exit 0：725 通过、3 跳过、5 未选；结构 0 失败 / 155 条审阅提示 | `.cache/i02/check.log` |
| `make coverage` | exit 0：782 通过、9 跳过；行 96.04%、分支 90.88%、增量 not_applicable（无 `origin/main` 基线） | `.cache/i02/coverage.log` |
| `make test-system` | exit 0：8 项通过（含需求线 6 项真实子进程用例） | `.cache/i02/test-system.log` |
| CLI 契约 | `requirement status --json` 纳入快照；`make cli-contract-check` exit 0 | `contracts/cli-contract.json` |
| 架构契约 | 模块路径镜像不变；`make architecture-contract-check` exit 0 | `contracts/architecture.json` |
| 变异（新纯规则核查） | 4 文件 819 变异 / 434 杀死 / 171 幸存 / 214 no tests；`domain/status.py` 无幸存与 no tests，已纳入；`requirement`／`task_plan`／`artifact` 暂不纳入 | 本机 `mutmut` 3.8.0 实测 |
| 变异（当前核心范围 8+status） | **exit 1**：970 变异 / 787 杀死 / 120 幸存（清单 116）/ 63 no tests；既有红点，详见第 26 节 | 本机 `mutmut` 实测 |
| 真实模型/容器/发布部署/真实 CI | **未执行**：本批次未提交、未推送；组合式假 PI 与场景／系统测试**不等于**真实闭环 | — |

### CI 状态

| 作业 | 触发 | 最近运行 | 结果 |
| --- | --- | --- | --- |
| quality / security / commit-policy | push、PR、手动 | [38337591368](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38337591368)（提交 08b3f08，2026-10-13 10:35） | 三作业 success（本批次：审查门 + 发布部署链路 + 文档） |
| quality / security / commit-policy（上一批次） | push | [38331898625](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38331898625)（提交 f28635c） | 三作业 success |
| mutation | 每日 19:00 UTC（= 03:00 Asia/Shanghai）、手动 | [38330443954](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38330443954)（提交 4394282） | success；本机同批实测 `512/596 killed, 84 survivors (84 reviewed)` |
| Release | 标签 `v*` 推送 | 尚未运行（仓库无标签） | 未执行 |
| Deploy | Release 发布或手动 | 尚未运行 | 未执行 |

自托管 runner 已在本机安装并在线，**GitHub 侧标签已确认**：`debian-forgeloop`（`self-hosted`、`Linux`、`X64`、`forgeloop-deploy`）状态 **Idle**（2026-10-13 所有者核对 Runners 页面）。安装见[自托管 runner 说明](self-hosted-runner.md)。

修复前四作业全绿记录见 [38258313311](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38258313311)。下一次自动变异运行：2026-10-14 03:00（Asia/Shanghai）。

### 远程与提交

- `origin` → `Lijiajin95/ForgeLoop`；本地 `main` 领先 `origin/main`（`ba335e6` 未推送），无标签、无 stash；同一工作区另有会话在开发架构契约门槛（未提交，故 `docs/architecture.md` 与快照处于在途状态）。
- **推送受阻原因（如实记录）**：`git push` 触发 pre-push 时，pre-commit 会 stash 未 staged 改动，使架构契约门禁在 hook 期间看到“源码含未提交 `graph/evidence.py`、文档回退到已提交版本”的不一致视图而失败；另有一个部署用例真实安装在负载下偶发 30s 超时。计划在 18:00 后随提交批次统一处理并推送。
- 2026-10-13 上午推送三个提交：`f35ff0c` 所有者授权的临时提交窗口修订、`0f4aa3b` S1–S3 代码与测试、`f28635c` 文档（部署/runner/分支保护/状态）。
- 2026-10-13 10:3x 推送本批次三个提交：`2049adb` 审查门 fail-closed、`a00ebff` 发布→部署链路接通、`08b3f08` 计划文档与状态记录同步。
- 更早的主要提交（完整列表见 `git log`）：`71d74eb` 变异门槛修复、`fe7b249` CI 结果记录、`59fc87e` CI 节奏调整、`4faa283` 新节奏执行记录、`7301fb1` 状态记录拆分。

### 所有者决定（2026-10-12）

- 撤销 30 小时人工投入上限与人工时间／ROI 测量；价值判断以交付质量与使用体验为准。
- B04（验收后自动归并 main 与 GitHub 同步）提前启用。
- 变异门槛移出推送关键路径，改为每日作业（推送 CI 保留三作业）。
- 2026-10-12 深夜：**CD 交付目标定为本机 Debian 设备**（提前启用 B05），要求只部署同一份已验收产物并保留可核对的回滚入口。
- 发布版本号由所有者**显式指定**（`vMAJOR.MINOR.PATCH`），不自动递增；自动版本体系仍属 B06。
- 部署触发方式：GitHub Actions **自托管 runner**，专用标签 `forgeloop-deploy`，仅部署作业使用本机。

### 所有者决定（2026-10-13）

- S3 采用**方案 B**（候选分支 → 匿名等待必需检查 → 快进 main → 删除候选分支，不需要 PAT）：代码侧已实现并实测。
- **明确授权在禁止提交窗口内提交 S1–S3 批次**，并选择"临时策略修订"路径：`config/commit-policy.toml` 的 `blocked_start`/`blocked_end` 临时由 `09:00–18:00` 缩为 `00:00–00:01`（策略要求 `start < end`，无法置零），文件内已留痕原值与恢复义务。
- **待恢复（必须完成）**：2026-10-13 18:00 之后的合法窗口把 `blocked_start = "09:00"`、`blocked_end = "18:00"` 写回并删除临时期说明；恢复本身也是一次 commit，必须落在合法窗口内。恢复前不得把本项标记为完成。
- 独立审查结果缺失或非结构化时**中断并标记原因，交人工决定**（不放行、不当作阻断消耗失败轮次）。
- 发布→部署采用**显式 `workflow_dispatch` 派发**（不引入 PAT／App 长期凭据）；`release.published` 仅保留给人工创建 Release 的场景。
- **禁止提交窗口改为两段**：09:00–12:00 与 13:30–18:00（午间 12:00–13:30 可提交）；`config/commit-policy.toml` 改用 `[[blocked_windows]]` 多段配置。
- **窗口内只有所有者明确授权的提交才允许**；临时放宽配置不构成授权，授权与恢复义务按批次记录（先例与本次违规见可靠性方案第 20、22 节）。
- 授权 2026-10-13 18:00 后提交 5 项：窗口违规与规则记录、PI 工作目录、审查契约与失败回边、T01 与计划文档、变异工具链修复与清单重导。

### 所有者决定（2026-10-17）：提交策略改为可选本机配置

- **仓库只保留模板** `config/commit-policy.template.toml`，**实际生效的配置不入库**：原 `config/commit-policy.toml`（含 2026-10-13 授权批次登记）原样移入本机 `.cache/forgeloop/commit-policy.toml`，规则值未变；另一候选位置为用户级 `~/.config/forgeloop/commit-policy.toml`。
- **没有配置文件即不执行提交时间禁止**：`--check-now`／`--audit` 放行并显式标注 `policy_absent`／NOT enforced，不把「没有规则」读成「检查通过」；配置损坏、年历目录缺失、旧路径 `commit-policy.local.toml` 未迁移仍**拒绝**（失败关闭）。
- 消息头 Conventional Commits 校验与配置无关，**始终生效**；「默认/覆盖键级合并 + 覆盖白名单 + 生效来源枚举」机制整体删除（不再有可合并的仓库默认）。
- 由此产生的**未落实项（如实记录）**：未安装配置的机器（含未注入配置的 CI）上时间规则不生效；需要服务端强制须在 CI 步骤注入配置，**当前未实现**。实施与实测记录见[可靠性方案第 29 节](engineering-reliability.md)。

## 2. A01 真实闭环

尚未执行：仓库内没有 `.forgeloop/records.sqlite` 真实任务记录，第一个真实小任务（候选：为 `status --json` 增加字段）未提交。自迭代链路的证据目前来自场景测试（`tests/scenario/test_self_iteration.py`，使用假 PI 真实改副本、真实 diff、副本内真实测试，源 main 未被改写），**不等于**真实模型闭环已验证。

## 3. 已实现的工程门槛

结构度量、覆盖、变异、CLI 契约、提交策略、依赖审计（pip-audit）、Ruff S 子集 + 本地 AST 检查、Import Linter、deptry 均已落地并有可重跑负例；门槛来源为 `config/quality-policy.toml`。业务关键路径同样有负例：独立审查在结果缺失/类型错误/无文本时中断（`review_result_invalid`，假 PI 三种畸形输出 + 场景负例）；CLI 状态读取失败报到 stderr（故障替身 + 真实任务）。变异门槛对未审阅幸存者复测一次后再判定，用于吸收 mutmut 子集测试的运行级噪声（±1 变异体）。**2026-10-13 晚起结构数字只是审阅提示、过期已审变异条目只是提示、pylint 退出门禁**（第 25 节）。细节与负例矩阵见方案第 11 节、第 19 节、第 25 节。

## 4. 运行方式（现状）

- 本地：`make setup`、`make check`（静态门禁＋高频测试）、`make check-static`（仅静态门禁，CI 用）、`make coverage`、`make mutation`、`make security`、`make test-system`、`make test-install`（低频真实安装层）、`make pi-live`（显式选择加入）。
- 项目线命令：`forgeloop project add <id> --name <显示名> --path <仓库>`（登记并建立 `projects/<id>/` 与 `repo.git` 镜像）、`project list|show|update`、`project migrate <id> --from <旧根> --legacy-project <旧项目名>`（旧记录一次性迁入）；`--records-root` 是登记根，业务记录在 `projects/<id>/` 内。
- CLI 附加命令：`forgeloop merge`（B04 受控归并：有远程时默认走候选分支 + 等必需检查 + 快进 main；`--direct-push` 为不安全直推、`--require-checks none` 用于无 CI 仓库）、`forgeloop release <task> --tag vX.Y.Z`（S1 受控发布；`--no-push` 只建本地标签）、`forgeloop deploy --tag vX.Y.Z`（S2 受控部署；`--artifact … --bootstrap` 为工具首次安装的引导路径）、`forgeloop rollback [--to X.Y.Z]`、`forgeloop candidate <task_id>`（C01 候选产物：单次调用内构建并验证）。
- 需求线命令：`forgeloop requirement submit|revise|analyze|plan|approve|advance|accept|status`（I01 入口）；任务推进复用既有单任务图与 `approve <task> --stage acceptance`；`requirement status --json` 结构由 CLI 契约快照守住。
- 状态页（B01 只读）：`forgeloop web`（默认 `http://127.0.0.1:8710/`，`--port 0` 由系统分配；`--refresh-seconds` 覆盖 `config/web.toml` 的 `refresh_seconds`，0 关闭自动刷新；`--project <id>` 只看一个已登记项目，缺省跨项目聚合并在条目上标出项目）；只读，批准与推进仍在 CLI。
- 邮箱交互（B02 需求级）：`forgeloop mail interact --once --project <已登记项目> --allowed-sender <地址> --imap-host … --smtp-host …` 交给 cron 单次执行；`--pi-command` 配置后可在邮件中执行分析／规划／推进，未配置时只回复配置缺失。只处理白名单发件人，批准必须显式写任务包版本，重复邮件与回信由 `mail_interactions` 幂等。既有 `mail poll|confirm` 分类工作流保留。
- 前端：`make frontend-setup`（npm ci）、`make frontend-check`（高频门禁）、`make frontend-build`（写回随包产物）、`make frontend-e2e`（真实浏览器）、`make frontend-mutation`（Stryker＋幸存者审阅判定）、`make frontend-audit`。
- 已安装 CLI：`~/.local/bin/forgeloop`（→ `~/.local/share/forgeloop/current/bin/forgeloop`）；部署与回滚细节见[部署说明](deployment.md)。
- CI：推送三作业 + 每日变异作业 + 标签发布的 Release 作业 + 自托管 runner 上的 Deploy 作业；分支保护与必需状态检查**未设置**（方案见[分支保护方案](branch-protection.md)），CI 结果目前不是合入门槛。

## 5. 与历史记录的关系

本文件只保留“现在是什么状态”；为什么这样改、失败与验证过程见[工程可靠性方案](engineering-reliability.md)第 13–19 节；后续要做的事见[待实现需求列表](pending-requirements.md)与[RoadMap](roadmap.md)。

## 6. 未完成与缺口（如实记录）

| 项 | 现状 |
| --- | --- |
| A01 真实代码闭环 | **已完成（2026-10-15/16）**：以 ForgeLoop 自身为目标的真实任务多轮闭环——需求提交→分析→方案批准→独立副本实现→独立审查→真实正式测试→人工验收→受控归并，十余个签名提交落地并经 GitHub 验签；原始记录见任务记录库与发现清单 |
| A05 备份 | 未执行（依赖本机独立硬盘） |
| 分支保护／必需状态检查 | **已设置（2026-10-16 核对）**：规则集 `main-protection`（target=branch，enforcement=active）生效；经典 branch protection API 未启用（采用 ruleset 机制）；代码侧候选分支流程已实现并实测。**GitHub 账号级 Signing Key 登记自 2026-10-18 起不再是要求**（本机 SSH 签名与 `required_signatures` 规则保留，账号现有登记未动）。方案见[分支保护方案](branch-protection.md) |
| 变异回归发现延迟 | 最多滞后一天；夜间失败只有 Actions 页面可见（无通知） |
| 变异判定噪声 | 已通过复测确认收敛，但源头（mutmut 子集测试偶发失败）未根除 |
| 审查结果契约 | 已修复为 fail-closed（非结构化/缺失结果中断，不判为“无阻断”）并有负例；**真实模型返回畸形结果时的行为未实测**（仅假 PI 覆盖） |
| 发布→部署链路 | 断点已修复（`actions: write` + 显式派发，2026-10-13）；**真实端到端未执行**（需一次真实标签交付，会创建 Release 并派发本机部署） |
| 部署引导测试 flake | **发现但不碰**：`tests/scenario/test_deployment_refusals.py::TestBootstrapRefusals::test_install_failure_is_reported` 在整套负载下偶发 pytest-timeout（>30s，`uv venv` 变慢；单跑 6.94s 通过），复跑整套通过；建议后续单独放宽该测试超时或复用缓存环境 |
| `make hooks` | 2026-10-13 **11:0x 才在本仓库实际安装**（此前 09:1x 的提交未经 hook 校验——原记载有误，已更正）；hook 内已补 `PRE_COMMIT_HOME` 指向工作区缓存目录（沙箱禁止写 `~/.cache`），并实测拦截窗口内提交（第 22 节） |
| I01 三条业务线入口 | 代码与门槛已落地：`requirement` 命令、`RequirementTaskRunner`、需求状态 JSON 契约；需求线系统用例通过（组合式假 PI＋真实检查点与测试命令）。**真实模型闭环已执行**（G01/G02，2026-10-15/16）：真实 PI 分析、任务包生成、独立副本实现、独立审查与真实正式测试均已跑通；假 PI 仍用于系统用例 |
| 邮箱交互入口（B02 需求级） | **需求级已实现并已真实邮箱验证（2026-10-19）**：`mail interact --once` 支持提交／追问／状态／分析／规划／批准／推进／整体验收／帮助，复用需求、任务包与执行记录；白名单、自动回复过滤、Message-ID 幂等、回信先落库再发送、中断不重放均有测试；QQ 邮箱真实跑通受理→回信、状态查询与所有者人工 `help` 回复（见本文件 2026-10-19 条目）。**未实现**：任务级验收／追加授权邮件命令、主动进度与成果通知、DKIM/SPF/DMARC 来源校验。**未验证**：真实 cron、真实 PI 邮件驱动、真实自动回复样本。真实部署要求：白名单登记全部实际发件地址；部分邮箱重写 Message-ID，线程关联依赖主题 `req-…`。既有 `mail poll|confirm` 分类工作流尚未适配多项目记录根 |
| 需求线真实端到端（G02） | **部分执行（2026-10-15/16）**：分析→任务→交付（含独立审查、真实正式测试、人工验收与受控归并）已用真实模型多轮跑通；**发布→部署段未执行**（尚无真实发布） |
| 变异门槛 | **当前通过（2026-10-19 实测）**：`make mutation` 1082/1242 杀死、160 幸存全部登记审阅（含本批新增 `domain/agent_runtime.py` 与 18 条等价变异；首次运行 25 个未审阅幸存者已按“补测试 7 个＋审阅 18 个”处理，见[第 30 节](engineering-reliability.md)） |
| 容器隔离 | PI 与 DSH 仍直接宿主运行（架构 §5 的受限容器未接入；容器镜像也只装 PI，容器+DSH 未验证） |
| S1 真实发布 | 未执行：仓库仍无标签。**A01 已于 2026-10-16 完成**（已有真实任务归并记录），首个发布可由所有者指定版本号执行 `forgeloop release` |
| S2 真实部署链路 | 引导部署已在真实前缀执行；**「Release → 自托管 runner → 本机部署」未执行**（需先有真实发布），真实两版本回滚未演练（本机仅一个版本） |
| S3 CI 合入门槛 | 代码侧完成（候选分支流程 + 检查判定）；**ruleset 已设置**（`main-protection`，active，2026-10-16 核对）；GitHub 真实检查下的端到端归并**未验证**（本地用假检查状态覆盖通过/失败/超时/重试） |
| 工作树清洁 | 当前工作树包含多项目隔离批次与并行邮箱交互入口的未提交改动；**未创建 commit**（所有者未要求）。此前 2026-10-16 的干净基线记录保留在历史批次 |
| 多项目旧记录迁移 | **代码与命令已落地**（`project add` + `project migrate`，旧库混合项目身份时整体拒绝）；本机仓库根 `records.sqlite` 为 0 任务/0 需求，**未做真实迁移演练** |
| 提交窗口 | **2026-10-17 起为可选本机策略**：仓库只发布模板，生效配置在本机（`.cache/forgeloop/commit-policy.toml`，2026-10-17 已安装且沿用 09:00–12:00、13:30–18:00 与 09:00–09:55 窄口）；**无配置的机器不执行时间禁止**（判定 `policy_absent`）。见「所有者决定（2026-10-17）」与[可靠性方案第 29 节](engineering-reliability.md) |
| 窗口违规记录 | 2026-10-13 10:34–10:37 的 4 个未授权窗口提交已如实记录（可靠性方案第 22 节）；当时规则入档于 `config/commit-policy.toml`——该文件自 2026-10-17 起移出仓库为模板 + 本机配置（同一授权批次登记随规则原样迁移） |
| 已安装 CLI 版本 | `~/.local/bin/forgeloop` **当前不存在**（2026-10-16 核对）：引导构建已移除，日常开发改用仓库内 `.venv/bin/forgeloop`；重新安装需经受控路径并使用**新版本号**（同版本不同产物已被守卫拒绝），属 S1 真实发布之后的事 |
| 质量批次（Q 线） | 方案已写：[质量保障方案](quality-assurance-plan.md)（Q00）；**2026-10-13 所有者决定暂停 Q 线、先跑通真实业务，检查项按需再加**。Q01 的检查项在本机落地一轮后已回退，工作区不保留新增门禁（第 24 节）；方案中的 95% 覆盖、新增 Ruff 规则、actionlint／zizmor／Gitleaks、扩展属性 1000 与全量覆盖**都不是当前有效门槛**。状态与重启条件见 [RoadMap 第 5 节](roadmap.md)与[待实现需求列表第 5 节](pending-requirements.md)。当晚的门槛精简（第 25 节）只降级既有形式门槛，不是 Q 线重启 |
| 覆盖门禁 | **当前通过（2026-10-16 复跑）**：`make coverage` 行 95.76%、分支 91.42%、增量通过（门槛仍 90%）。同一晚 21:1x 首跑 exit 1（行 93.29%、分支 85.23%），归因于另一会话在途的 `graph/evidence.py`；此前的 89.97% 记录（`domain/requirement.py`、`graph/nodes.py`）已随 `0584245` 的测试补齐消失——两段失败都**未**通过下调门槛解决 |
| 权限隔离 | **未完成**：容器隔离未接入，PI 仍直接宿主运行。因此「运行未修改源 main」只证明本次行为，**不构成「PI 无权修改 main」**——该结论待受限执行环境（V-A02／B01）单独验收（可靠性方案第 25 节、DogFood 计划 G01） |
| 结构数字 | 函数行数、文件长度、公开接口数、复杂度、参数数、分支数均为**审阅提示**（2026-10-14：0 失败 / 155 条提示）；只有配置损坏、源码不可读或解析失败让结构门禁失败。不为数字超限拆函数或拆文件（可靠性方案第 25 节） |
| 真实 CI | **已在 GitHub 执行（2026-10-16）**：`quality` 与 `commit-policy` 作业通过。`security` 曾因 `pip-audit` 报 `mcp 1.29.0` 的 CVE-2026-59951 失败；经核实 `mcp` 仅为 `semgrep` 的开发期传递依赖、`semgrep` 精确钉死 `mcp>=1.29.0,<1.29.0+`（最新 1.181.0 仍如此，无法升级）、且漏洞路径（stateful 模式 Streamable HTTP 服务端）在本仓库不可达（0 处引用 mcp／0 处实现 MCP 服务），已按所有者授权在 `make audit` 登记**带复查条件的例外**，`make security` 复跑通过（`No known vulnerabilities found, 1 ignored`；SAST 4 规则 0 命中）。复查条件：`semgrep` 放宽钉死或本仓库开始使用 `mcp` 时必须移除该例外。**2026-10-17 更新：SAST 引擎已由 semgrep 换为 Ruff S 子集 + 本地 AST 检查；`mcp` 与 `semgrep` 已离开依赖树，`make audit` 不再传 `--ignore-vuln`，该审计例外已移除（见可靠性方案第 27 节）。** |
