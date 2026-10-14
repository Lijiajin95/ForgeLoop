# 本机部署与回滚（P1 S2）

把已验收并发布的产物部署到**这台 Debian 设备**：只使用同一份已发布产物，独立版本目录，
原子切换激活，保留上一版本与可核对的回滚入口。

## 不变量

- **同一份产物**：控制路径只接受 Release 上发布的 wheel，且其 sha256 必须等于 Release 的
  `SHA256SUMS`；不匹配即拒绝，**不重新构建**。
- **身份绑定**：标签指向的提交必须等于 S1 发布回执里的归并提交，部署日志同时固化任务、
  归并提交与产物校验值。
- **不被覆盖**：每个版本装在 `releases/<version>`，已存在的版本目录一律拒绝覆盖。
- **原子激活**：先建临时符号链接再 `os.replace` 覆盖 `current`，切换瞬间不存在半激活状态。
- **可核对回滚**：回滚只允许切到已安装且留有产物校验记录的版本；`deployments.jsonl` 是权威记录。
- **失败如实报告**：冒烟检查失败时**不自动回退**，保留现场并打印确切的恢复入口。
- **独立恢复入口**：恢复命令直接调用上一稳定版本的 `releases/<previous>/bin/forgeloop`，
  **不经过 `current`**；因此 `PATH` 上的 `forgeloop` 已指向坏版本、甚至坏版本无法启动时，
  仍能恢复旧版本。每次部署、回滚都追加 `deployments.jsonl`，失败也有回执；回滚只追加、
  不删除记录，回滚后既有记录仍可读取。

## 目录布局

```text
~/.local/share/forgeloop/
├── releases/<version>/            每版本一个独立 venv（不覆盖旧版本）
│   ├── .venv/                     该版本的依赖环境
│   └── bin/forgeloop              稳定入口 shim → .venv/bin/forgeloop
├── current -> releases/<version>  激活指针（原子切换）
├── artifacts/                     下载到的产物原件与 SHA256SUMS（便于复核）
├── cache/uv、toolchain/python     部署自带的 uv 缓存与解释器目录（不依赖家目录缓存）
└── deployments.jsonl              部署日志：版本、产物校验值、来源、上一版本、冒烟结果
```

`~/.local/bin/forgeloop` 是一次性符号链接，指向 `current/bin/forgeloop`，因此后续部署
（切换 `current`）无需再动它。

## 首次安装（引导路径，bootstrap）

工具自身第一次安装时尚无发布回执，必须显式使用 `--bootstrap` 并在日志里标注来源
（不冒充控制路径）：

```bash
cd /home/link/Project/ForgeLoop
uv build                                        # 产出 dist/forgeloop-<version>-py3-none-any.whl
.venv/bin/forgeloop deploy --tag v0.0.1 \
  --artifact dist/forgeloop-0.0.1-py3-none-any.whl \
  --bootstrap --bootstrap-note "首次安装：工作副本构建产物" \
  --prefix ~/.local/share/forgeloop
mkdir -p ~/.local/bin
ln -sfn ~/.local/share/forgeloop/current/bin/forgeloop ~/.local/bin/forgeloop
```

**本机已执行的记录（2026-10-13 08:10，Asia/Shanghai）**：部署 `v0.0.1`，来源 `bootstrap`，
产物 `forgeloop-0.0.1-py3-none-any.whl`，校验值 `ab03c19885c7aac7a35fd20a212bcf754a1616825c91c39f5e18f82cb2350c4e`，
冒烟 `exit 0`；安装环境为独立 venv（Python 3.13.5，langgraph 可导入）。

## 受控部署（发布路径）

```bash
forgeloop deploy --tag vX.Y.Z --prefix ~/.local/share/forgeloop --records-root ~/forgeloop-records
```

流程：读取该标签的发布回执（S1）→ 从 Release 下载 wheel 与 `SHA256SUMS`（公开仓库匿名下载，
无需凭据）→ 校验 sha256 → 核对标签提交与回执一致 → 安装新版本目录 → 原子切换 → 冒烟检查
→ 写部署日志。`--repo owner/name` 可在无法从回执任务推断仓库时显式指定。

## 回滚

```bash
forgeloop rollback --prefix ~/.local/share/forgeloop          # 回到最近记录的上一版本
forgeloop rollback --to 0.0.1 --prefix ~/.local/share/forgeloop --note "原因"
```

回滚同样做原子切换与冒烟检查，并追加日志；不删除任何版本目录。

## 新版本冒烟失败时的恢复

受控部署先安装、激活，再冒烟检查（`current/bin/forgeloop --help`）。冒烟失败时**不回退**，
保留现场并把新版本连同 `smoke_exit_code` 写入 `deployments.jsonl`。此时 `PATH` 上的
`forgeloop`（以及 `current/bin/forgeloop`）已指向坏版本，直接执行会再次调用坏版本；命令会
打印独立恢复入口，直接调用上一稳定版本的 shim：

```text
FAIL: 冒烟检查失败（exit=3）：...
未自动回退；上一版本: 0.0.1
恢复稳定版本（无需调用新版本）: ~/.local/share/forgeloop/releases/0.0.1/bin/forgeloop rollback --prefix ~/.local/share/forgeloop
```

按提示执行该入口即可原子切回 `0.0.1`；因为它不经过 `current`，坏版本即使完全无法启动也能恢复。
若这是首次部署、没有上一版本，命令会明确提示无可回退版本，按「首次安装」重新引导即可。
回滚只向 `deployments.jsonl` 追加一条记录、保留全部历史，因此恢复后既有记录仍可读取。

## 自动化（GitHub Actions）

- 工作流：[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)。触发路径两条：
  - **自动（标签交付）**：`release.yml` 创建 Release 后**显式 `workflow_dispatch` 派发**本工作流
    （`gh workflow run deploy.yml --ref <tag> -f tag=<tag>`）。这一步必需：按 GitHub 规则，用
    `GITHUB_TOKEN` 创建 Release 所产生的 `release.published` 事件**不会**触发下游工作流（只有
    `workflow_dispatch` 与 `repository_dispatch` 例外），只靠 `release.published` 会断链。
  - **人工**：在 GitHub 上手动创建 Release（`release.published` 生效），或手动 `workflow_dispatch`
    并填标签。
- 运行位置：**自托管 runner**，标签 `forgeloop-deploy`（安装步骤见
  [自托管 runner 说明](self-hosted-runner.md)）；作业调用本机**已安装**的 forgeloop 部署，
  形成自升级链路。
- 若作业一直排队，通常是 runner 缺少 `forgeloop-deploy` 标签或未在线；在仓库
  Settings → Actions → Runners 页面核对标签与状态。

## 未验证与已知边界

- 「Release → 自托管 runner → 本机部署」的真实端到端链路**尚未执行**：需要一次真实交付
  走完 S1 发布（标签 + Release）后才能验证；当前只有引导路径的真实验证。链路本身已修复
  （2026-10-13：原配置只靠 `release.published`，而 `GITHUB_TOKEN` 创建的 Release 事件不触发
  下游工作流，`release.yml` 现改为显式派发 Deploy）。
- **真实两版本回滚未在真实前缀演练**：本机目前只安装了一个版本；回滚链路由场景测试
  （真实文件系统 + 真实安装 + 真实切换）覆盖，等第二个版本交付后补真实演练。
- runner 标签是否包含 `forgeloop-deploy` 无法在本地核对（标签在 GitHub 侧），需在 Runners
  页面确认。
- 部署目录不含生产凭据；本机部署不需要任何 token。
