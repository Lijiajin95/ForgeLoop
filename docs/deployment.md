# 安装、升级与恢复（本机 DSH 插件）

本文描述当前实现的操作步骤。新首版的同包验证、第三方受控发布与上线判定见[统一方案](product.md#8-客户入口发布与运维)，自动发布链路尚待实现。
历史构建角色 V0／V1 及其操作记录见[交付记录](delivery/2026-10-22-typescript-dsh.md)，下文使用实际目标 profile 与候选包。

## 1. 选择目标与前置条件

- DSH 和 Node 满足[插件包声明](../packages/forgeloop/package.json)，并有可用模型接入。
- 明确目标 DSH home、profile、项目路径与记录根；业务库为 `<recordsRoot>/projects/<project>/records.sqlite`。
- 安装前保留上一已验证 tarball、`artifact.json` 和配置／记录副本，记录本次目标与包摘要。

| 使用场景 | 入口 | 注意事项 |
| --- | --- | --- |
| DSH Desktop 的 desktop profile | §4，宿主插件管理器 | 应用独占，不用 CLI 启动、转储或手动改 manifest |
| 非桌面专用 profile | §2 或 §5，DSH CLI | 显式核对 `DSH_HOME` 与 profile，避免装到其他环境 |
| 真实宿主验收 | §8，仓库验证脚本 | 使用测试 home；与正式模型配置分开，按实际方式提供认证 |

以下 shell 命令在仓库根目录运行，路径占位符须替换为实际目标。操作成功仍需 §6 的版本和行为检查。

## 2. 从源码安装（开发用）

此例仅用于非桌面 profile；将 home 和 profile 替换为已准备好的开发环境：

```sh
export DSH_HOME="/abs/path/to/development-dsh-home"
export FORGELOOP_PROFILE="forgeloop"
npm install --cache .cache/npm-cache
npm run build --workspace forgeloop-dsh
dsh plugin --profile "$FORGELOOP_PROFILE" add "$PWD/packages/forgeloop"
dsh --profile "$FORGELOOP_PROFILE" --dump-config | grep forgeloop-dsh
```

源码安装为 `link:` 依赖，重新构建并重启该宿主后加载。它用于开发，不算安装包验证。
插件的项目与模型路由配置见[包说明](../packages/forgeloop/README.md)。

## 3. 构建候选安装包

```sh
npm run candidate --workspace forgeloop-dsh
```

输出 `packages/forgeloop/dist/forgeloop-dsh-<version>.tgz` 与 `artifact.json`，保存版本、大小、
SHA-256、文件清单、构建时 Git HEAD 与工作树状态。运行时也保留按已交付 diff 在独立快照构建、
打包并记录摘要的内部操作，但当前没有人类入口调用它。构建完成不等于已经安装或验收。

## 4. 安装到桌面 profile

通过 DSH 宿主插件管理器的 `install_bundle` 安装目标 tarball。最近安装记录与摘要见[状态记录 §9](status.md#9-移除输入框工作流选择器2026-10-26)。
当批结果为 `application: applied`，宿主重载后刷新页面生效；不能据此假设每次安装都不需重启。
按管理器结果完成必要的重载／重启，再执行 §6；安装回执本身不证明业务行为正常。

## 5. 安装候选包到非桌面 profile

在独立终端明确目标，避免沿用上一操作的测试或开发 home：

```sh
export DSH_HOME="/abs/path/to/target-dsh-home"
export FORGELOOP_PROFILE="forgeloop"
dsh plugin --profile "$FORGELOOP_PROFILE" add /abs/path/to/candidate.tgz
dsh --profile "$FORGELOOP_PROFILE" --dump-config | grep forgeloop-dsh
ls -ld "$DSH_HOME/profiles/$FORGELOOP_PROFILE/node_modules/forgeloop-dsh"
```

确认候选安装为目录而非 `link:`，按宿主要求重载／重启，再执行 §6。
不要以安装目录名或 package 版本字符串单独证明运行的是目标候选。

## 6. 安装后检查

通过 DSH 工具卡片调用只读工具：

```text
forgeloop_status
forgeloop_evidence <已有需求身份>
forgeloop_impact <需求身份>
```

核对安装依据、工具与页面关键入口、本次改动的业务行为及必要历史读取；配置从宿主日志和
profile 配置核对。安装不删除业务库和证据；新方案丢弃旧业务数据是独立的清理事项，
不能顺带删除 DSH 配置、凭据或其他项目。
安装目标、测试环境、实际结果和未验证项分别记录，不把测试 home 成功当作正式目标已验证。

## 7. 恢复上一已验证版本

1. 先保存当前状态与异常依据，确定上一已验证包及摘要，并检查当前数据能否由它读取。
2. 桌面 profile 使用 §4 的宿主入口；非桌面 profile 使用 §5 的 CLI 入口，指定旧 tarball。
3. 完成必要重载／重启，按 §6 检查旧版本行为、业务记录及故障是否恢复。
4. 保留记录与失败历史；未知请求和未收口动作先核对，不盲目重放。

若数据不兼容，不能仅靠重装旧包宣称恢复，也不能默认整库覆盖丢掉升级后的新数据。另行明确处置方案。

## 8. 真实宿主验收环境

[验证脚本](../scripts/ts/verify-plugin.ts)读取 `FORGELOOP_DSH_HOME` 和 `FORGELOOP_PROFILE`，默认分别为
`.cache/forgeloop/dsh-home` 与 `forgeloop`；只设置普通 `DSH_HOME` 不会覆盖脚本选择。

```sh
export FORGELOOP_DSH_HOME="$PWD/.cache/forgeloop/dsh-home"
export FORGELOOP_PROFILE="forgeloop"
make verify-plugin
```

前提是该测试 home 中已准备 profile、安装包与可用模型认证；新 home 不自动继承正式配置。
需要手动调用同一测试实例时，用 `DSH_HOME="$FORGELOOP_DSH_HOME" dsh --profile "$FORGELOOP_PROFILE" ...`。
`make verify-plugin` 检查安装形态、组合层并真实调用模型工具。
这些检查覆盖宿主接缝，不能代替统一方案要求的完整业务端到端验证。

## 9. 已知限制

- DSH 接缝与版本兼容需实际验证；当前已有证据见[状态记录](status.md)。
- 安装／卸载不是业务事务，异常后按实际副作用核对并恢复。
- 插件卸载会停止协调器并请求取消在途 Agent；重启后未收口请求需核对，不能把卸载成功等同于副作用已清理。
- 旧 Python、独立 HTTP 服务及旧 `forgeloop` CLI 不参与当前安装与恢复。

## 10. 独立测试环境

测试环境必须与正式环境分开，不能只靠 `--patch` 覆盖同一个 `DSH_HOME`：

- 独立 `DSH_HOME`（例如 `~/.dsh-forgeloop-test`），从而分开 sessions、storages 与凭据文件；
- 独立 profile（例如 `forgeloop-test`），单独安装候选包；
- 独立 `recordsRoot`（例如测试 DSH_HOME 下的 `forgeloop/`），正式库不得指向该目录；
- 独立 `projectPath`，优先使用测试副本或 git worktree，避免测试改正式工作树；
- 独立端口（例如 3091），正式 Web 继续使用 3080；
- 测试凭据使用独立副本或专用测试凭据，权限保持 600，不进入版本库或候选包。

启动示例：

```sh
DSH_HOME="$HOME/.dsh-forgeloop-test" \
  dsh --profile forgeloop-test --no-open --port 3091
```

正式与测试配置应分别保存在各自 DSH_HOME 的 profile 中；不要让正式 profile 的
`recordsRoot` 指向测试目录，也不要在测试 profile 中操作正式记录根。启动日志会打印实际
`records` 路径，可用于核对。测试结束应关闭测试实例；正式实例的重启与切换需另行确认。
