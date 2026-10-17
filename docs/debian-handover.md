# Debian 服务器交接（迁移与继续开发）

> 交接时点：**2026-10-18 00:1x（Asia/Shanghai，Mac 工作副本）**
> 目的：把这台 Mac 上的在途工作、运行环境要求与已知坑交接给 **Debian 服务器**，让服务器能继续推进 ForgeLoop 自身迭代，并最终实现「**通过邮件开发新功能**」。
> 与 [docs/deployment.md](deployment.md) 的分工：那份讲**把 ForgeLoop 产物部署到机器上**（release → deploy → rollback 的自升级链路）；本文讲**把开发工作与运行现场迁到 Debian**并继续迭代。

---

## 1. 交接时的真实事实（可逐条核验）

| 项 | 值 | 核验方式 |
| --- | --- | --- |
| 本地 HEAD | `f380fc1`（`refactor(policy)!: 提交策略改为可选本机配置，仓库只发布模板`）| `git rev-parse --short HEAD` |
| 远端 `origin/main` | `1eb2823` → **本地领先 4 个提交，尚未推送** ✗ | `git rev-parse --short origin/main` |
| 未推送的 4 个提交 | `7b522bb` 更新 AGENTS.md 项目定位与硬规则；`447834e` Web 只读状态页 + 前端门禁；`31fb423` 架构图补全；`f380fc1` 提交策略改可选本机配置 | `git log --oneline origin/main..HEAD` |
| 工作树 | **干净**（0 处改动）| `git status --porcelain` |
| 今日（10-17）提交 | **14 个**，ForgeLoop 自身迭代的部分全部签名有效且 GitHub `verified=true` | `git log --oneline --since="2026-10-17 00:00"` |
| 需求 | **18 个**：**8 个整体验收通过**（已归并）、9 个执行中、1 个草稿 | `forgeloop requirement status <req_id>` |
| 已核验、排队待落地 | `git-worktree-guard`、`prereq-detection-core` 处于验收门（`awaiting_acceptance`）；`core-release-action` 已交付（`delivered`）| 见 §7 |
| 收尾状态 | **所有推进器已停止、无活动任务**（所有者 2026-10-18 指令：完成当前任务后停止后续）| 见 §7.4 |
| 实测发现清单 | **26 条编号条目**（编号至 **#30**，含 28b/29b 补充），全部有实测证据 | `.cache/dogfood/runs/selfiter-findings.md` |
| 记录库 | `records.sqlite` **2.0 MB**、`checkpoints.sqlite` **5.1 MB** | `du -sh .cache/dogfood/selfiter-records/*.sqlite` |
| 记录库目录总量 | **12 GB**（几乎全是每个任务的 `workspace/`，**不要带走**）| `du -sh .cache/dogfood/selfiter-records` |
| 主干门禁现状 | ❌ **`make coverage` 红**：`tests/unit/test_planning_repo_facts.py::TestFactsMatchRealRepository::test_every_tracked_path_is_legal` 失败（发现 #25），且分支覆盖率 **89.79%**（阈值 90%）| §7.1 |

**未验证事项（如实声明）**：邮箱功能**尚未实现**（见 §6）；「Release → 自托管 runner → 本机部署」端到端链路**从未真实执行**（见 §8）；主干覆盖率红灯**未清除**（见 §7.1）。

---

## 2. 迁移时带什么、不带什么

### 2.1 必须带走（其余都可重建）

```bash
# ① 权威记录库：所有需求/任务/批准/工时/人工决定都在这里，不在 git 里
.cache/dogfood/selfiter-records/records.sqlite        # 2.0 MB
.cache/dogfood/selfiter-records/checkpoints.sqlite    # 5.1 MB（中断任务的就地续跑现场）

# ② 协调侧实测证据与工具（非产品，但对继续工作极有价值）
.cache/dogfood/runs/selfiter-findings.md              # 30 条实测发现
.cache/dogfood/runs/selfiter-findings.md 之外的：
.cache/dogfood/runs/*.md                              # 设计、交接、决策清单
.cache/dogfood/*.sh                                   # 推进/落地原语（land-one.sh 等）
```

### 2.2 **不要**带走

| 内容 | 原因 |
| --- | --- |
| `.cache/dogfood/selfiter-records/task-*/workspace/` | 每任务约 0.5 GB，合计 **12 GB** 中的绝大部分；需要历史候选时挑 `<task>/candidate.diff`、`test-run.jsonl`、`reviews.jsonl` 即可 |
| `.cache/uv/`、`.venv/` | 平台相关；Debian 上重建（§3）|
| `.cache/forgeloop/commit-policy.toml` | 本机策略（§5 在 Debian 上按新规则重建）|
| `~/.config/forgeloop/mail-secret` | 凭据绝不入库/入档；Debian 上重建（§6）|

---

## 3. Debian 基础环境

```bash
git clone git@github.com:Lijiajin95/ForgeLoop.git && cd ForgeLoop
make setup     # 按仓库配置安装依赖组（Python 版本、uv 版本以仓库配置与锁文件为准，不在此硬编码）
make hooks     # 安装 pre-commit / commit-msg / pre-push（含提交消息头校验；提交时段校验见 §5）
make check     # 基线自检
```

> 版本纪律：语言、运行时、包管理器与依赖版本**由仓库配置与锁文件维护**（见 `AGENTS.md`），迁移时只需保证 `make setup` 能装齐依赖组；不要照抄本文档里的旧版本号。

---

## 4. 提交签名（不配好会被服务端拒绝）

```bash
ssh-keygen -t ed25519 -f ~/.ssh/forgeloop_signing -N ''
# 把 ~/.ssh/forgeloop_signing.pub 注册到 GitHub → Settings → SSH and GPG keys → New SSH key → **Signing Key**
git config --local gpg.format ssh
git config --local user.signingkey ~/.ssh/forgeloop_signing.pub
git config --local commit.gpgsign true
```

核验：`git log --show-signature -1` 应为 `Good "git" signature`，且推送后 GitHub 上显示 **Verified**。Mac 上已落地的提交全部满足（`%G?=G` + `verified=true`）。

---

## 5. 每机器提交时段策略（**2026-10-17 起已改为"可选本机配置"**）

⚠️ **规则变了，务必按新规则做**（[ADR-0002](adr/0002-commit-policy-as-local-opt-in.md)）：

- 仓库**只发布模板** `config/commit-policy.template.toml`；**实际生效的配置不入库**。
- 生效配置位置（二选一）：`<仓库>/.cache/forgeloop/commit-policy.toml` 或 `~/.config/forgeloop/commit-policy.toml`。
- **没有生效配置的机器不执行提交时段禁止**：命令放行并在输出标注 `policy_absent` 与 NOT enforced（属"未落实"，不得声称检查通过）。
- ⚠️ **旧路径 `~/.config/forgeloop/commit-policy.local.toml` 已废弃**：未迁移时按**拒绝**处理（fail-closed）。

Debian 上若要**启用**本机限制（例如只在非工作时段提交），做法：

```bash
mkdir -p ~/.config/forgeloop
cp <仓库>/config/commit-policy.template.toml ~/.config/forgeloop/commit-policy.toml
# 按需修改 blocked_windows / machine_label / enforce_work_hours
```

若要**不限制**（服务器 7×24 跑流水线时通常如此）：**不创建**该文件即可（会如实标注 `policy_absent`）。

核验：

```bash
.venv/bin/python scripts/check_commit_policy.py --validate-config
.venv/bin/python scripts/check_commit_policy.py --check-now
```

> 历史实测（旧机制下已验证过"按机器区分"）：同一时刻周一 10:30，Mac 拒绝、Debian 放行，来源分别记为 `repository_default` / `local_override`，机器标签 `debian-server`。新机制下等价效果通过"是否创建生效配置"实现。

---

## 6. 邮箱凭据与**邮箱功能的真实现状** ⚠️

### 6.1 现状：邮箱功能**尚未实现**（这是"用邮件开发新功能"的前置）

| 项 | 事实 |
| --- | --- |
| `src/forgeloop/mail/` | **只有 `__init__.py`**（分层已登记，实现未开始）|
| `config/mail*.toml` | **不存在**（模板属 `mail-governance` 任务的交付物）|
| 需求 `req-20261016021551-ed498a` | 任务包 **v6 已批准**（4 个任务：`mail-ports` → `mail-smtp-send` → `mail-imap-receive` → `mail-governance`），但**被 `plan_approval_stale` 缺陷（#24）卡住**，该缺陷的修复需求 `229835` 正在实现中 |
| 所有者指令（2026-10-17） | **先把邮箱任务做完，再交所有者决策是否发布** |

### 6.2 迁移后重建凭据（绝不入库）

```bash
mkdir -p ~/.config/forgeloop && chmod 700 ~/.config/forgeloop
printf '%s\n%s\n' '437336207@qq.com' '<QQ 邮箱授权码>' > ~/.config/forgeloop/mail-secret
chmod 600 ~/.config/forgeloop/mail-secret        # 权限必须 600，否则凭据层拒绝使用
cp config/mail.example.toml ~/.config/mail.toml  # 模板随 mail-governance 任务落地后才有
```

设计要点（已固化在实测发现里，实现时会遵循）：口令**走文件优先**（不导出环境变量）；配置优先级 `--config` > `FORGELOOP_MAIL_CONFIG` > `<repo>/config/mail.toml` > `~/.config/mail.toml` > `~/.config/forgeloop/mail.toml`；生产配置不入库。

---

## 7. 当前卡点与开放决策（交接的关键）

### 7.1 主干覆盖率红灯 ❌（**所有落地都被它挡住**）

- **现象**：干净主干上 `make coverage` 失败 —— `tests/unit/test_planning_repo_facts.py::TestFactsMatchRealRepository::test_every_tracked_path_is_legal`（"`git ls-files` 未返回任何跟踪文件"），另加分支覆盖率 **89.79%**（阈值 90%）。
- **讽刺的闭环**：修这个测试正是排队中的 `git-worktree-guard` 任务（发现 #25）—— **修它的任务被它造成的红灯挡住**。
- **已排除**：候选工作区（旧基线 `1eb2823`）门禁**全绿**（1384 passed、覆盖率通过），证明失败源自主干而非候选。
- **待所有者决定（三选一）**：① 授权在落地该任务时**仅排除这一个已知红灯测试**并完整披露（其余门禁全跑）；② 由另一个会话修该测试；③ 先补分支覆盖率。

### 7.2 已核验、排队待落地的任务

| 任务 | 修复的缺陷 | 核验结果 | 当前状态 |
| --- | --- | --- | --- |
| `prereq-detection-core` | **#13** 前置候选已在基线却被判应用失败（卡住 3 个需求）| 审查多轮抓到真实漏洞后修好 | `awaiting_acceptance`（验收门）|
| `git-worktree-guard` | **#25** mutation 作业红 | 审查 0 阻断、63 passed | `awaiting_acceptance`（验收门）|
| `core-release-action` | **#26** dev 中断后"未核对动作"无法释放 | 审查 0 阻断、正式测试通过 | `delivered`（已交付，待落地）|

落地后立即解锁：`549538`、`12af1b`、`568eac` 三个需求，以及 `docs-and-contracts-sync` 的续跑。
⚠️ **更正**：`git-worktree-guard` **不能**清除主干这道红灯（实测应用后该测试仍失败）—— 它修的是"缺 `.git` 时的工作树探测"（发现 #25），与 §7.5 的 `frontend/` 路径未登记是**两件不同的事** ✗。

### 7.3 其他开放项

- **4 个提交未推送** ✗（`7b522bb`、`447834e`、`31fb423`、`f380fc1`）：同步远端时会一并上远端；注意其中 Web/前端与策略重构提交可能让 CI 的覆盖率作业变红（与 §7.1 同一根因）。
- **发布决策**（8 个已验收需求）：`forgeloop release <task_id> --tag vX.Y.Z` 需所有者指定版本号；会创建 GitHub Release 并派发部署。
- **需求 `229835`**（#24 计划批准缺陷修复）：任务包 v6 已获所有者批准；其任务一 `t1-pin-regression` 尚未完成（见 §7.4），因此**邮箱主线仍被 #24 卡住**。
- 需求 `e5ac23`（#26 修复）、`62525a`（#13 修复）已批准并实现中（后者任务一已到验收门）。

### 7.5 同步远端被阻断的精确原因（2026-10-18 00:2x 实测）

**现象**：本地已提交的交接文档（`037fcb8`，签名有效）**无法推送** ✗ —— 不是网络或凭据问题，而是 **pre-push 钩子跑测试后被拒** ✗（也不会用 `--no-verify` 绕过 ✗）。

**根因（已定位到具体文件）** ✗：`test_every_tracked_path_is_legal` 失败的断言是第 3 条：

```
AssertionError: 真实仓库路径被固定事实误拒：{
  'frontend/.dependency-cruiser.cjs': '不在仓库合法路径清单内（源码分层、测试分层、文档、契约快照或已知顶层文件）',
  'frontend/.prettierignore': …，'frontend/.prettierrc.json': …，
  'frontend/eslint.config.js': …，'frontend/knip.json': …，
  'frontend/package-lock.json': …，'frontend/package.json': …，
  'frontend/playwright.config.ts': … }
```

即：提交 `447834e feat(web): B01 只读状态页与 TypeScript 前端门禁` 引入了 `frontend/` 目录，
但**没有在同批改动里登记进仓库的合法路径事实**（`src/forgeloop/domain/repo_facts.py` 的路径规则与
`contracts/architecture.json`），于是"真实仓库里存在未被固定事实承认的跟踪路径"被测试如实拦下——
这正是 `AGENTS.md` 要求的「架构变化必须同步架构描述」，只是这次漏了同步。

**重要澄清**：这**不是**发现 #25 的同一问题 ✗。`git-worktree-guard`（已核验候选）修的是"缺 `.git` 时的工作树探测"，
实测把它应用到主干后该测试**仍然失败**（`1 failed`），因此**不要**指望它来清这个红灯。
（§7.1 中"修它的任务会一并转绿"的说法据此更正 ✗。）

**如何解除（已按所有者 2026-10-18 授权执行 ✓）**：协调侧做了这次机械登记 —— 在
`src/forgeloop/domain/repo_facts.py` 的 `AUXILIARY_ROOTS` 中承认 `frontend` 树，并修正 `_looks_like_file`
使真实的点文件（`frontend/.prettierrc.json`、`frontend/.dependency-cruiser.cjs`、`frontend/.prettierignore`）
不再被"末段不是文件名"误拒，同时**保留**对点目录（`.github`、`frontend/.cache`）的拒绝；新增回归用例覆盖两侧。
`scripts/export_architecture_contract.py --check` 通过（契约快照无需变更）；该修复见紧随本文档之后的 fix 提交。

> 解除前的状态（保留备查）：本地提交只能停留在本机（文档提交已签名未推送），主干门禁的 `test` 与 `coverage` 两道都红 ✗。

### 7.4 收尾状态（2026-10-18 00:2x，按所有者指令停止后续）

| 项 | 结果 |
| --- | --- |
| 当前任务（`t1-pin-regression`，#24 修复的第一个任务）| **已结束，未完成** ✗：`time_exhausted`（单会话 2 小时 + 累计额度用尽；dev 尝试 **6 轮**，其中一轮审查曾干净通过、随后一轮审查输出格式损坏（发现 #30））|
| 现场是否保留 | ✅ **完整保留**：`candidate.diff`（41 KB）、`reviews.jsonl`（8.5 KB）、`test-run.jsonl`（78 KB）、`dev-reports.jsonl`、`sessions/`、`workspace/` |
| 后续任务 | ✅ **全部停止**：`parallel-driver.sh`、`night-driver2.sh`、`run-fixes.sh` 均已停止；记录库中无 `implementing/reviewing/testing` 任务 |
| 如何恢复该任务 | 追加额度（`forgeloop grant <task_id>`）+ **放宽单会话超时**（`--pi-timeout-seconds 7200`，这是让同型任务 `prereq-detection-core` 跑通的杠杆）+ 带理由 `retry`；或**缩小任务范围**（它一次要写 3 个测试文件，是可拆分的大任务）|
| 仍未处理 | 主干覆盖率红灯（§7.1）、未推送的 4 个提交（§7.3）、发布决策（§7.3）|

---

## 8. CD（发布 → 部署）现状

- 工作流：`.github/workflows/quality.yml`（quality／security／commit-policy 三作业）、`release.yml`、`deploy.yml`、`mutation-nightly.yml`。
- CLI：`candidate`（构建并验证候选产物）、`release`（打标签）、`deploy`（安装并原子激活）、`rollback`（两版本回滚）—— 详见 [docs/deployment.md](deployment.md)。
- **待办（需所有者/管理员操作）**：**自托管 runner 尚未安装**（[docs/self-hosted-runner.md](self-hosted-runner.md) 需要一次仓库管理员操作取注册 token）；「Release → runner → 本机部署」端到端**从未真实跑过**，需要一次真实发布才能验证。

---

## 9. 在 Debian 上如何继续（命令手册）

### 9.1 产品命令（每天用）

```bash
# 看状态（权威事实与真实阻塞原因都在这里）
.venv/bin/forgeloop requirement status <req_id> --records-root <记录库目录>

# 单条推进（跑到验收门或人工决策点即返回）
.venv/bin/forgeloop requirement advance <req_id> \
  --pi-command '["pi","--mode","rpc","--no-session","--provider","<provider>","--model","<model>"]' \
  --project-path "$PWD" --baseline "$(git rev-parse --short HEAD)" \
  --pi-timeout-seconds 3600 --records-root <记录库目录>

# 并行推进多条（同需求不重复运行，受并发上限约束）
.venv/bin/forgeloop requirement dispatch <req_id> <req_id> … --max-concurrent 3 …

# 中断任务的人工续跑（必填 --by/--reason；校验不通过不写决定）
.venv/bin/forgeloop requirement retry <req_id> --task <slug> --by owner --reason "…" …

# 整体验收 / 批准任务包 / 追加失败额度
.venv/bin/forgeloop requirement accept <req_id>
.venv/bin/forgeloop requirement approve <req_id> --by owner --source "…"
.venv/bin/forgeloop grant <task_id>          # +3 失败轮次（累计不清零；不延长工时）
```

### 9.2 三条必须知道的操作纪律（血的教训）

1. **不要反复调用 `analyze` / `plan`** ✗（发现 #27）：每次 `plan` 都会生成**新的任务包版本**，而运行器取"最新版本"，于是刚批准的版本立刻变成"旧版本" → 需求被锁死（#24）。失败重试前先看状态。
2. **`blocked_reason` 会陈旧** ✗（发现 #29）：需求行上的原因可能是早已不成立的历史值（掩盖真实阻塞）。**以 `requirement status` 里任务行的"工时/阻断原因"为准**。
3. **人工核对必须留痕** ✓：清检查点现场前先备份（`cp checkpoints.sqlite backups/checkpoints-<时间>.sqlite`）；释放"未完成动作"要把 `actions` 行标为 `interrupted` 并写明理由与时间；续跑一律带 `--by owner --reason`。

### 9.3 协调侧工具（`.cache/dogfood/`，非产品）

| 文件 | 用途 |
| --- | --- |
| `runs/selfiter-findings.md` | **30 条实测发现**（IMAP 编码、QQ 行为、模型故障、记账坑、规划版本膨胀、审查格式损坏…）|
| `land-one.sh` | 落地原语：应用候选 → 主干门禁（`make check`/覆盖率/系统/契约）→ 只暂存候选文件 → 签名提交 → 推送 → 验签 → 补记归并与产物身份；失败回滚（含未跟踪文件清理）；**只拦候选文件冲突，允许他人在途改动** |
| `parallel-driver.sh` | 并行驱动：`dispatch --max-concurrent` + 自动落地；支持 `FORGELOOP_NO_LAND=1` 只推进不提交 |
| `night-driver2.sh` | 单机顺序驱动（含陈旧记账前置清理）|
| `runs/*.md` | 设计、决策清单、交接件 |

---

## 10. 最重要的 10 条实测发现（迁移后继续前请先读）

| # | 发现 | 影响 |
| --- | --- | --- |
| 13 | 前置候选**已在基线**却被 `git apply --3way` 判失败 → `prerequisite_blocked` 死循环 | 卡住 3 个需求；修复在排队 |
| 24 | 需求被重新规划后，任务永久卡在 `plan_approval_stale` | 邮箱主线被卡 |
| 25 | 规划仓库事实测试在 mutmut 的 `mutants/` 副本里因无 git 工作树而失败 | 夜间 mutation 红 + **主干覆盖率红**（§7.1）|
| 26 | `retry` 只清 `halted_reason`，不解除"未核对动作" → dev 中断任务无法续跑 | 每次中断都需人工释放 |
| 27 | 重复 `plan` 抬高任务包版本 → 触发 #24 | **协调侧操作纪律**（§9.2）|
| 29 | `blocked_reason` 陈旧，掩盖真实阻塞（真实原因是工时耗尽）| 曾误导致 1 小时排查 |
| 29b | **工时限额没有人工延长入口**（`grant` 只管失败轮次）| 只能改 `budget.limit_seconds` |
| 30 | 后续审查输出格式损坏会**覆盖先前"干净通过"的结论** | 已通过的候选被反复退回 |
| — | IMAP：`imaplib` 强制 ASCII，中文文件夹需 **modified UTF-7**（如 `其他文件夹` = `&UXZO1mWHTvZZOQ-`）；服务端 `SUBJECT` 搜索不可信；声明字符集可能是错的 → 容错解码；服务端会改写 `Message-ID` → 用收到的 id 做幂等键；QQ 自寄只落「已发送」 | 邮箱实现必须遵守 |
| — | 提交消息必须 `type(scope): 描述` 且首行 ≤100 字符（hook 强制）；`/tmp` 可能被清理 → 消息文件放工作区 | 提交纪律 |

---

## 11. 一句话交接

**代码、门禁与记录库都可以交出去** ✓：本地领先 4 个提交待推送 ✓、8 个需求已验收 ✓、修复任务已核验待落地 ✓、26 条编号发现（至 #30）与全部人工决定都已留痕 ✓。
**但有三件事必须先处理** ✗：① 主干覆盖率红灯（§7.1，需一次明确决定）；② 邮箱功能尚未实现（§6.1），且其前置修复 `229835` 的任务一因额度耗尽未完成（§7.4）——**先把它推进落地，才谈"通过邮件开发新功能"**；③ 按所有者指令，本机已**停止后续任务**，接力点在 Debian（§7.4）。
