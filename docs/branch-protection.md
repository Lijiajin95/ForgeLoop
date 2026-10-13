# 分支保护（P1 S3）配置方案

目标：让 CI 成为 **main 的合入门槛**，同时保留首版需求 §5 的"保留 main 主干、取消强制 PR"。

状态：**方案，尚未执行**（设置需要仓库管理员在网页操作或提供 PAT）。执行后须按文末"验证"记录真实结果。

## 1. 先弄清楚一个容易搞错的点

GitHub 的"必需状态检查"在文档里的语义是 **合并**路径：

- 经典分支保护：*"After enabling required status checks, all required status checks must pass before
  collaborators can **merge** changes into the protected branch."*，并补充 *"After all required status
  checks pass, any commits must either be pushed to another branch and then merged or pushed directly to
  the protected branch."*（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)）
- ruleset 规则表把这条写作 "Require status checks to pass **before merging**"。
  （[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)）
- 真正**阻断直接推送**的是另外两条：`Require workflows to pass before merging`（文档明确写"Applying this
  rule **will block direct pushes**"）与 `Restrict updates`（只有 bypass 权限者能推送匹配分支）；
  经典保护里的对应开关是 `Require a pull request before merging`。

结论：只勾"必需状态检查"时，它对**直接推送**的约束并不明确，必须用**小范围试验**确认，不能假设。
下面用 ruleset 的 **Evaluate（观察）模式**先跑，再切 Active。

## 2. 对本仓库的直接影响（先看这条）

`forgeloop merge` 原来是**把新提交直接推送到 main**。若启用后检查在推送时生效，这个推送会被拒绝。
按文档给出的合法路径，归并流程要改成"先推候选分支 → 检查通过 → 再落到 main"。

**代码侧已实现（方案 B，2026-10-13）**：有远程且未加 `--no-push` / `--direct-push` 时，`forgeloop merge <task>` 默认执行：

1. 从交付基线建候选分支 `forgeloop/<task_id>` 并提交候选改动（**main 指针不动**）；
2. 推送候选分支（触发 CI）；
3. **匿名**轮询 `check-runs`（不需要任何凭据），默认等待 `quality,security,commit-policy` 三个检查；
4. 检查全部通过后快进 main（`git merge --ff-only`，即把已通过检查的同一个 SHA 落到 main）并推送；
5. 删除候选分支（本地 + 远程）；证据写入记录目录的 `merge-evidence.json`。

- 检查失败 / 超时 / 读取异常：**main 不动**，候选分支保留供核对，进程退出码 1，证据记录原因与轮询次数。
- 仓库没有 CI 时用 `--require-checks none`（不等待检查，其余流程相同）。
- 未启用分支保护、需要沿用旧行为时用 `--direct-push`（明确标注为不安全路径）。
- 等待时长用 `--checks-timeout`（默认 1800 秒）控制。

## 3. 推荐配置（仓库 ruleset，先 Evaluate 后 Active）

网页步骤：

1. 仓库 → Settings → Rules → Rulesets → **New branch ruleset**；
2. Name `main-protection`；**Enforcement status: Evaluate**（只观察、不阻断）；
3. Target branches：默认分支 `main`；
4. 勾选规则：
   - `Restrict deletions`（默认开）
   - `Block force pushes`（默认开）
   - `Require linear history`（本仓库历史是线性的）
   - `Require status checks to pass`：加入三个作业名 `quality`、`security`、`commit-policy`
     （来源工作流 `Engineering quality`，见 [.github/workflows/quality.yml](../.github/workflows/quality.yml)）；
     建议同时勾 `Require branches to be up to date`
   - 暂不启用 `Require signed commits`（本机未配置签名密钥）
5. Bypass list：保留 **Repository admin** 可绕过（紧急情况可用；日常不使用，绕过行为在仓库 Insights/Audit 可见）；
6. 观察几次推送与一次合并后，把 Enforcement 改为 **Active**。

API 方式（需 fine-grained PAT，权限 `Administration: read and write`；本机未装 `gh`）：

```bash
TOKEN=...   # 不要把 token 写进仓库
curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Lijiajin95/ForgeLoop/rulesets \
  -d '{
    "name": "main-protection",
    "target": "branch",
    "enforcement": "evaluate",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "rules": [
      {"type": "deletion"},
      {"type": "non_fast_forward"},
      {"type": "required_linear_history"},
      {"type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          {"context": "quality"}, {"context": "security"}, {"context": "commit-policy"}
        ]}}
    ]
  }'
```

bypass 名单建议在网页里设置（`bypass_actors` 需要仓库角色对应的 `actor_id`，以 API 返回为准，不要猜）。
查询当前规则：`curl -H "Authorization: Bearer ${TOKEN}" .../repos/Lijiajin95/ForgeLoop/rulesets`。

## 4. 启用前后要做的三件事

| 顺序 | 事项 | 说明 |
| --- | --- | --- |
| 1 | 本机 hooks：`make hooks` | 提交时段与消息校验 + 推送前快速测试；不依赖服务端，立刻生效 |
| 2 | `forgeloop merge` 适配候选分支流程 | 见第 2 节；**必须在 Active 之前完成** |
| 3 | 真实验证 | 一次归并后确认三作业 success；再故意推一个会失败的改动，确认被拒绝且 main 未变 |

## 5. 验证记录（执行后填写）

| 项 | 结果 |
| --- | --- |
| 候选分支流程（本地真实 git + 裸仓库远程 + 假检查状态） | **已实测**：通过→快进并删分支；失败/超时→main 不动、分支保留（`tests/scenario/test_merge_flow.py`，11 项） |
| 规则已创建（Evaluate） | 未执行（需要所有者在网页操作或提供 PAT） |
| 切 Active 后首次真实归并（GitHub 真实检查） | 未执行 |
| 失败检查时服务端拒绝直接推送且 main 未变 | 未执行 |
