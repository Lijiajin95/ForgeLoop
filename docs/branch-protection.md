# 分支保护与服务端规则（P1 S3，2026-10-15 按实际配置订正）

目标：让服务端只强制**不可逆操作**的防护与**提交签名**，其余行为规范继续走**软性规则**
（提交时段策略、Conventional Commits、CI 检查）。保留首版需求 §5 的“保留 main 主干、取消强制 PR”。

状态：**已执行**（规则集 `main-protection` 已 Active 并通过真实验证）。

## 1. 先弄清楚一个容易搞错的点

GitHub 的“必需状态检查”在文档里的语义是 **合并**路径：

- 经典分支保护：*“After enabling required status checks, all required status checks must pass before
  collaborators can **merge** changes into the protected branch.”*，并补充 *“After all required status
  checks pass, any commits must either be pushed to another branch and then merged or pushed directly to
  the protected branch.”*（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)）
- ruleset 规则表把这条写作 "Require status checks to pass **before merging**"。
  （[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)）

即：**必需状态检查不阻断直接推送**，真正约束直推的是 `Restrict updates`、`Require workflows to pass
before merging` 或 `Require a pull request before merging`。

另一条本计划实测得到的结论：**`Evaluate`（试运行）模式是 Enterprise 专属**。本仓库（个人账号、公开仓库）
调用 API 创建 ruleset 并指定 `enforcement: evaluate` 时，服务端返回
`422 Validation Failed: Enforcement evaluate option is not supported on this plan. Please upgrade to Enterprise
to enable it.` —— 因此本仓库**直接以 Active 部署最小集**，并对**非默认分支**做等价实测来验证规则真的生效。

## 2. `forgeloop merge` 的候选分支流程（已实现并实测）

有远程且未加 `--no-push` / `--direct-push` 时，`forgeloop merge <task>` 默认：

1. 从交付基线建候选分支 `forgeloop/<task_id>` 并提交候选改动（**main 指针不动**）；
2. 推送候选分支（触发 CI）；
3. 轮询 `check-runs`，默认等待 `quality,security,commit-policy` 三个检查
   （读取凭据：`GITHUB_TOKEN` / `GH_TOKEN`，缺失时匿名并显式告警）；
4. 检查全部通过后快进 main（`git merge --ff-only`，即把已通过检查的同一个 SHA 落到 main）并推送；
5. 删除候选分支（本地 + 远程）；证据写入记录目录的 `merge-evidence.json`。

检查失败 / 超时 / 读取异常：main 不动，候选分支保留供核对，退出码 1，证据记录原因与轮询次数。
等待时长用 `--checks-timeout`（默认 1800 秒）控制；仓库没有 CI 时用 `--require-checks none`。

## 3. 实际配置（规则集 `main-protection`）

| 项 | 值 |
| --- | --- |
| 名称 / id | `main-protection` / 25133735 |
| 模式 | **active** |
| 目标 | 默认分支 `main`（`~DEFAULT_BRANCH`） |
| 规则 | `deletion`（禁删除）、`non_fast_forward`（禁强推改写历史）、`required_signatures`（要求签名提交） |
| bypass | 所有者本人（User 12952426，mode=always）——保证受控归并流程可直推 |

**刻意不启用**（附理由，均为所有者 2026-10-15 决定）：

| 规则 | 不启用理由 |
| --- | --- |
| `pull_request` | 单人项目不需要强制 PR；且会直接掐断 `forgeloop merge` 的直推流程 |
| `update`（限定写入身份） | 本机所有 Agent 都使用所有者凭据，服务端限制无实际意义 |
| `required_status_checks` | CI 每次推送都会跑（软性规则已足够）；必需检查不阻断直推，收益有限 |
| `workflows` | 会强制走 PR 路径，与上一条同理 |

API 方式（fine-grained PAT，权限 `Administration: read and write`）；等价创建：

```bash
curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Lijiajin95/ForgeLoop/rulesets \
  -d '{
    "name": "main-protection",
    "target": "branch",
    "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "bypass_actors": [{"actor_id": 12952426, "actor_type": "User", "bypass_mode": "always"}],
    "rules": [
      {"type": "deletion"},
      {"type": "non_fast_forward"},
      {"type": "required_signatures"}
    ]
  }'
```

签名密钥：本机以 SSH 签名（`gpg.format=ssh`、`user.signingkey=~/.ssh/id_ed25519.pub`、`commit.gpgsign=true`，
写入仓库本地配置），并在 GitHub 账号登记同一把公钥为 **Signing Key**。

## 4. 启用顺序（已全部完成）

| 顺序 | 事项 | 状态 |
| --- | --- | --- |
| 1 | 本机 hooks：`make hooks` | 已启用（提交时段与消息校验 + 推送前快速测试） |
| 2 | `forgeloop merge` 适配候选分支流程 | 已实现（见第 2 节） |
| 3 | 服务端规则集 Active + 真实验证 | 已完成（见第 5 节） |

## 5. 验证记录（真实结果）

| 项 | 结果 |
| --- | --- |
| 候选分支流程（本地真实 git + 裸仓库远程 + 假检查状态） | **已实测**：通过→快进并删分支；失败/超时→main 不动、分支保留（`tests/scenario/test_merge_flow.py`） |
| 规则已创建（Active） | **已完成**：`main-protection`，规则 `deletion`+`non_fast_forward`+`required_signatures`，bypass=所有者 |
| 禁删除 / 禁强推 | **已实测**（临时分支挂同规则）：强推改写与删除分支均被拒，报错 `push declined due to repository rule violations` |
| 要求签名提交 | **已实测**：向挂该规则的临时分支推送**未签名**提交被拒；同时 main 上已有**已验证**提交（`git log --show-signature` 为 `Good "git" signature`，GitHub API 返回 `verified=true, reason=valid`） |
| 要求 PR（曾短暂启用后按所有者决定移除） | 已实测其行为：无 bypass 时直推被拒；有 bypass 时放行 |
| 正常推送不受影响 | **已实测**：普通快进推送放行 |
| DogFood 来源门禁技术负例（真实 git：无回执／补挂任务 ID／内容漂移／伪造签名） | **已实测**：`tests/scenario/test_dogfood_gate.py`（8 项）与 `tests/unit/test_dogfood_provenance.py`（22 项） |
| 来源门禁在 CI 启用（`config/dogfood-policy.toml` 的 `enabled=true`） | **待启用**：见第 6 节；当前 CI 作业只报告“待启用”并放行 |
| 服务端拒绝非受控直接推送 | **不适用**（所有者决定不做身份限制）：外部直接提交由来源门禁**检出**并进入救援流程，而非事前阻断 |

## 6. DogFood 提交来源门禁（C04，待启用）

机制：受控执行端 `forgeloop merge` 用环境变量 `FORGELOOP_DOGFOOD_SIGNING_KEY` 对来源回执做
HMAC-SHA256 签名，回执作为提交消息 trailer `ForgeLoop-Provenance` 随提交传递；可信校验端
`scripts/check_dogfood_provenance.py`（CI 作业 `dogfood-provenance`）重新计算提交实际内容并核对签名，
拒绝：无回执、回执重复、签名无效、任务 ID 不属于受控命名、基线不是提交祖先、候选内容漂移。
密钥只从环境变量读取，不写入仓库、不传入 PI 执行环境。

**启用前置（缺一不可）**，详见 `docs/dogfood-policy.md`：

1. 专用验证分支跑通负例（无回执 / 伪造签名 / 内容漂移均被拒绝）；
2. 登记仓库 Secret `FORGELOOP_DOGFOOD_SIGNING_KEY`；
3. `config/dogfood-policy.toml` 的 `enabled = true`；
4. 归并时把 `dogfood-provenance` 纳入必需检查（`--require-checks quality,security,commit-policy,dogfood-provenance`）；
5. 历史提交没有回执，需在专用验证分支按批启用，避免误伤已有历史。
