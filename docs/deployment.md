# 安装、升级与恢复（本机 DSH 插件）

本文描述当前 TypeScript 原生 DSH 插件的本地安装、候选打包、V0→V1 切换与恢复。旧的 Debian
wheel／systemd／热升级部署路径已退役，历史记录见 Git、[ADR 0006](adr/0006-supervised-hot-upgrade.md)
与 `legacy/`。

## 1. 前置

- DSH `0.2.1-rc.2`（或插件 `engines.dsh` 允许的版本）、Node ≥ 22.5；
- 一个可用的 DSH profile（示例名 `forgeloop`）与模型路由；
- 项目路径与记录根。记录根布局：`<recordsRoot>/projects/<project>/records.sqlite`。

## 2. 从源码安装（开发用）

```sh
npm install --cache .cache/npm-cache
npm run build --workspace forgeloop-dsh
dsh plugin --profile forgeloop add "$PWD/packages/forgeloop"
dsh --profile forgeloop --dump-config | grep forgeloop-dsh
```

源码安装是 `link:` 依赖：修改源码并重新构建后，重启宿主即可生效。它适合开发，**不能**用来
声称“验证了安装包”。

## 3. 构建候选安装包

```sh
npm run candidate --workspace forgeloop-dsh
```

输出 `packages/forgeloop/dist/forgeloop-dsh-<version>.tgz` 与 `artifact.json`（版本、大小、
SHA-256、文件清单、构建时的 git HEAD 与工作树状态）。通过插件内的正式流程构建时使用：

```text
/fl candidate <需求身份> <x.y.z>
```

它只应用已交付并绑定的 diff，在独立快照中构建、打包并核对 tarball 摘要。

## 4. 安装到桌面 profile（Electron 独占）

DSH CLI 拒绝修改 `desktop` profile（`profile "desktop" is managed exclusively by the Electron
application`）。本机的做法（2026-10-23 已执行）：

```sh
# 1. 备份
cp ~/.dsh/profiles/desktop/package.json        .cache/forgeloop/desktop-install/package.json.bak
cp ~/.dsh/profiles/desktop/cordis.patch.yml    .cache/forgeloop/desktop-install/cordis.patch.yml.bak

# 2. 安装包（在 profile 目录内用 pnpm，不经过 dsh plugin 的独占检查）
cd ~/.dsh/profiles/desktop
pnpm add "file:/abs/path/<tarball>"

# 3. 在 package.json 的 dsh.profile.bundles 追加 "forgeloop-dsh"
# 4. 在 cordis.patch.yml 覆盖 forgeloop 行的 recordsRoot/projectPath 等配置
# 5. 重启 DSH Desktop 才会加载
```

验证组合层不要直接 `--dump-config desktop`（同样被独占检查拒绝）。可复制 manifest 到临时
profile（`node_modules` 软链到 desktop）后 `dsh --profile <copy> --dump-config | grep forgeloop-dsh`，
本机已用此法验证。

## 5. 安装候选包（V1，非桌面 profile）

```sh
dsh plugin --profile forgeloop add /abs/path/forgeloop-dsh-<version>.tgz
# 必要时重启 DSH 宿主，使新包生效
```

安装后确认：

```sh
dsh --profile forgeloop --dump-config | grep forgeloop-dsh
ls -la "$DSH_HOME/profiles/forgeloop/node_modules/forgeloop-dsh"   # 应是安装目录，不是 link
```

`make verify-plugin` 会检查 profile 清单、安装形态、组合层，并用真实模型调用插件工具；
`make verify-plugin` 加 `--full`（或 `make test-host`）还会通过真实 `commands` 注册表执行
只读的 `/fl status`。需要宿主可用模型凭据；脚本不读取或打印密钥。

## 6. 验证新版本与历史

```text
/fl config
/fl status
/fl status <旧需求身份>
/fl evidence <旧需求身份>
/fl impact <需求身份>          # V1 起提供
```

- 记录库与证据目录不随插件版本删除；旧需求应仍可按身份查询。
- 候选包摘要、安装版本与运行版本应一致；不一致时如实记录，不声称升级成功。

## 7. 恢复 V0

1. 保留每版 tarball 与 `artifact.json`（示例：`.cache/forgeloop/artifacts/v0/`）。
2. 重新安装旧包：

   ```sh
   dsh plugin --profile forgeloop add /abs/path/<tarball>
   ```

3. 重启宿主，运行 `/fl config` 与 `/fl status` 确认版本与记录可读。
4. 恢复不得删除记录、证据或候选包；未知请求与未收口动作按记录核对，不自动重放。

## 8. 隔离验证环境

本机验证使用工作区内的 `DSH_HOME`，避免触碰桌面 profile：

```sh
export DSH_HOME="$PWD/.cache/forgeloop/dsh-home"
export FORGELOOP_PROFILE=forgeloop
```

该目录位于 `.cache/`（不入库），包含专用 profile 与模型路由补丁。真实用户使用时把同样的
插件安装到自己的 profile 即可。

## 9. 已知限制

- DSH developer preview：升级宿主后重新跑 `make verify-plugin`，不能假设跨版本兼容。
- 安装/卸载不是事务：tarball 损坏或宿主中断时按 §6 恢复，不伪造成功。
- 插件禁用/卸载会停止协调器并取消在途 Agent；已受理但未收口的请求保持 `unknown`，需人工核对。
- 无 Python、无独立 HTTP 服务；旧 `forgeloop` CLI 不再是安装或恢复入口。