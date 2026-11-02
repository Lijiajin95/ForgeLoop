# 分支保护与发布门禁

本文记录**已经能由仓库内代码强制执行**的门禁，以及仍需在 GitHub 仓库设置中手工
配置、当前**未落实**的项。按 [AGENTS.md](../AGENTS.md) 的规则，只有声明、没有机制的
限制一律标为“未落实”。

## 已落实：仓库内可执行门禁

| 门禁     | 触发                | 命令                                                                               | 失败即阻断       |
| -------- | ------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| 快速质量 | PR / push 到 `main` | `.github/workflows/quality.yml` → `make check-fast`                                | 是               |
| 格式     | PR / push           | `make format`（Prettier 检查）                                                     | 是               |
| 全量质量 | 每日定时 + 手动     | `.github/workflows/nightly.yml` → `make check` + `make coverage` + `make mutation` | 是（nightly）    |
| 发布     | 手动                | `.github/workflows/release.yml` → `make check`、`coverage`、`sbom`、`package`      | 是（release）    |
| 产权     | 任意改动            | `.github/CODEOWNERS` 指定所有者审阅                                                | 依赖 GitHub 设置 |
| 契约     | 本地/CI             | `make contracts`（分层、依赖、端点、文档链接）                                     | 是               |

真实宿主验收（`make verify-plugin`）需要模型凭据与自托管 runner，当前只在
`release.yml` 中以 `vars.ENABLE_REAL_HOST` 开关控制，**默认不执行**，因此不能算作
PR 的强制门禁。

## 已落实：GitHub 仓库设置（2026-11-02，个人开发档位 1）

`main` 已通过 REST API 配置分支保护，实际值如下（`gh api` 可查）：

| 配置                              | 值                     | 说明                               |
| --------------------------------- | ---------------------- | ---------------------------------- |
| Required status checks            | `quality`、`security`  | 来自 `quality.yml` 的两个 job      |
| Require branches to be up to date | 开启（`strict: true`） | PR 合并前必须先同步 `main`         |
| Allow force pushes                | 关闭                   | 禁止强推覆盖历史                   |
| Allow deletions                   | 关闭                   | 禁止删除 `main`                    |
| Required pull request reviews     | 关闭                   | 个人账号无法自我 approve，避免锁死 |
| Enforce admins                    | 关闭                   | 保留个人紧急处置能力               |

配置命令（等价，可重放）：

```bash
cat > /tmp/protection.json <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["quality", "security"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
gh api --method PUT repos/Lijiajin95/ForgeLoop/branches/main/protection --input /tmp/protection.json
```

限制与注意：

- **必需检查只作用于 PR 合并**。当前没有开启 “Require a pull request”，所以直接
  `git push origin main` 仍被允许，不会因 CI 失败被拦；要强制走 PR 需再加一条规则。
- 检查项在 `main` 上首次运行前可能显示 “Expected”；不影响直接 push，但会阻塞 PR 合并。
- `enforce_admins: false` 表示管理员仍可绕过（例如强制推送），个人项目保留该能力。
- 该配置是仓库设置，不在 Git 版本库内；换仓库或重建仓库需要重新应用。

## 未落实：更严格的分支策略

以下项**尚未开启**，个人开发默认不做；2026-11-02 所有者确认**只补文档与可回放命令，不改仓库设置**。
需要时按下方命令逐项应用（先 `gh auth status` 确认账号为仓库管理员）：

1. `main` 要求 PR（Required approvals = 0，避免自我 approve 锁死）；
2. Require review from Code Owners（单人仓库无意义）；
3. Require signed commits；
4. 禁止管理员绕过（`enforce_admins: true`）；
5. Tag 保护：仅 release workflow 可创建/移动 `v*` tag；
6. 全部分支禁删除（保护多机在途分支）；
7. 分支保护不区分机器：同一账号的每台机器权限相同，审计靠独立 SSH key，不靠规则。

### 可回放命令（未执行）

要求 `main` 必须走 PR（0 个批准，避免单人仓库自我锁死）：

```bash
gh api -X PUT repos/Lijiajin95/ForgeLoop/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["quality", "security"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

影响：开启后直接 `git push origin main` 会被拒绝，必须建分支 → PR → 合并；
现有本地提交策略（小型多次提交）需改为按分支推送。

限制 `v*` tag 的创建/移动/删除（GitHub 推荐用 ruleset）：

```bash
gh api -X POST repos/Lijiajin95/ForgeLoop/rulesets --input - <<'JSON'
{
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
JSON
```

影响：release workflow 若用默认 `GITHUB_TOKEN` 创建 tag，需要在 ruleset 的
`bypass_actors` 中加入该 workflow 对应的集成（或由管理员手动打 tag）；
应用前先跑一次 release 验证，避免发布被拦。

查看与回滚：

```bash
gh api repos/Lijiajin95/ForgeLoop/branches/main/protection
gh api repos/Lijiajin95/ForgeLoop/rulesets
gh api -X DELETE repos/Lijiajin95/ForgeLoop/branches/main/protection   # 回滚 PR 规则
```

## E2E 门禁现状（部分落实）

- 已有 `make e2e`：`scripts/ts/e2e.ts` 构建插件 → 临时 `DSH_HOME` + 独立 profile 安装 →
  校验 `--dump-config`（forgeloop-dsh 层、会话 preset）与 `plugin list`；
  不依赖模型，**仅覆盖装载/组合层**。
- `make e2e` 含两条：① 宿主装载校验（隔离 profile 安装 + dump-config/plugin list）；
  ② Playwright 看板路由（隔离配置启动 `dsh web`，token→cookie 后 POST
  `/api/forgeloop/board` 校验 200/project/summary），不读写生产记录。
- 已加入 `quality.yml` 的 `e2e` job：CI 安装与本地一致的 `@deepseek-ai/dsh@0.2.1-rc.4`
  后执行 `make e2e`；**尚未在 GitHub runner 实跑验证**，首次运行通过前不声称 CI 已覆盖。
- 按所有者要求，本轮改为**本地 CI/本地验证**，不推送到 GitHub。
- 该 job 尚未加入 `main` 的必需检查（需所有者确认后再改保护设置）。
- 没有浏览器/Playwright E2E；看板与 Web 接缝仍由 `tests/board-route.test.ts`、
  `tests/architecture-contract.test.ts` 等集成测试覆盖。
- 真实模型工具链由 `make verify-plugin` 覆盖（release workflow），需要模型凭据。

## 维护

- 门禁命令以 [Makefile](../Makefile)、`.github/workflows/` 与 `contracts/` 为准；
  本文只描述入口与设置，不复制判定参数。
- 修改必需检查列表时同步更新本文与 `docs/status.md`。
