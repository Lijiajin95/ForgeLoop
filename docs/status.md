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
