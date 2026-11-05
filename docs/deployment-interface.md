# 部署接口设计（需求方案，待评审）

状态：**方案草案；所有者已确认 §10 的五项决定（2026-11-03）。** P0 已实现：配置与校验、
状态机与工具结果解析、记录表、工具调用底座、协调器（preflight/审批/auto/apply/status）、
只读工具 `forgeloop_rollouts`、`DeploymentService` 运行时门面与看板动作端点、
回退（含 `data-rollback`）与内置 webhook 告警；页面只读展示与证据保留期尚未实现。
真实模型与真实外部工具（k8s/容器）集成未验证。
相关：[产品方案 §8.2 发布与数据迁移](product.md#82-发布与数据迁移)、[安装与升级](deployment.md)、
[运维 Agent](ops-agent.md)、[架构](architecture.md)。

## 1. 问题与定位

当前部署是“所有者手工装包 + 看板核对”：`deploy` 端点只验收已经装进 profile 的产物，不负责安装；
研发、验证、运维 Agent 都没有部署工具；制品形态只有 DSH 插件一种，设备只有本机。

**核心约束（所有者已明确）**：

- 部署的**实际配置操作必须交给外部工具**（Python 脚本、kubectl/k8s、shell 脚本等），
  Agent 不直接操作部署，ForgeLoop 也不内置部署机制。
- Agent 只能**读取部署状态**、**提议**某个已登记目标的部署；执行由主控在授权后调用登记工具完成。
- 部署接口独立于研发与运维；增加部署方式只加工具与登记，不改 Agent。
- **当前版本只支持单机**（`transport: "local"`），多机不在本版范围。

ForgeLoop 在部署里的职责只有四件事：**校验前置门禁 → 调用登记工具 → 记录证据与状态 → 部署后核对**。

非目标（本版不做）：多机/ssh、通用 CD 与配置管理平台、任意命令执行、凭据托管、
自动扩容、k8s Operator。数据库迁移与容器卷的回退**在范围内**，但执行与恢复由登记工具完成，
ForgeLoop 只声明范围、记录证据并在回退后核对。

## 2. 术语与领域模型

| 概念                 | 含义                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeploymentArtifact` | 一次构建的制品：id、kind（`dsh-plugin`/`process-bundle`/`container-image`）、version、sha256、文件清单、构建来源（requirement/plan/candidate） |
| `DeploymentTool`     | 一段登记的外部工具：id、kind（`python`/`shell`/`k8s`）、脚本路径与摘要、能力、超时、环境变量白名单                                             |
| `DeploymentDevice`   | 部署目标设备；本版只有本机 `local`，多机留到后续版本                                                                                           |
| `DeploymentTarget`   | 一个可部署位置：id、toolId、device、参数（profile/namespace/unit/image）、数据范围、默认 requirement（可空）、审批方式 |
| `DeploymentIntent`   | 一次部署请求：target、requirement、artifact、提议来源（owner/运维事件/CLI）、幂等键
| `DeploymentAttempt`  | 一次工具调用：intent、设备、状态、退出码、结果 JSON、证据路径                                                                                  |

部署工具是**唯一有部署副作用的地方**；ForgeLoop 不实现安装、不拼部署命令、不直接调 kubectl/docker。

状态机（`DeploymentAttempt.state`）：

```
draft → preflight_failed
      → awaiting_approval → rejected
      → ready → applying → applied_pending_verify → verifying → verified
                          └→ failed → rolling_back → rolled_back
applied_pending_verify ─(verifyTimeoutSeconds 内未收敛)→ verify_failed（告警，保留回退位）
```

`applied_pending_verify` 是必需中间态：装完到“实际运行版本符合预期”之间还要重载、等待、健康检查，
工具返回 `ok` 只证明它执行完了，不证明部署成功。`verify_failed` 只告警、不自动回退；
回退是所有者动作（或经批准的运维提议）。

## 3. 工具契约（部署的唯一入口）

配置登记工具，工具自带脚本与实现方式；ForgeLoop 按固定协议调用，不接受模型提供的路径或参数。

```ts
interface DeploymentToolDescriptor {
  id: string
  kind: 'python' | 'shell' | 'k8s'
  label: string
  version: string // deployment-tool-v1
  capabilities: readonly (
    'preflight' | 'apply' | 'status' | 'rollback' | 'data-rollback' | 'logs'
  )[]
}
```

调用协议（每次调用只做一件事）：

- 运行：`kind=python` → `python3 <script> --op <op> --plan <planFile>`；
  `kind=shell` → `/bin/sh <script> --op <op> --plan <planFile>`（`sh script`，不是 `sh -c` 字符串）；
  `kind=k8s` → 同样执行登记脚本，脚本内部调用 kubectl/helm；ForgeLoop 不直接调 kubectl。
- `planFile`：主控写到证据目录的 JSON，含 `intentId`、`op`、`artifact{sha256,path,version}`、
  `previous{sha256,path,restorePoint}`（回退时）、`target.params`、`device{id,transport}`、
  `data{volumes,migrations}`、`timeoutSeconds`。
- 数据范围：target 声明了 `data.volumes` 或 `data.migrations` 时，工具必须具备 `data-rollback`；
  `preflight` 必须在结果里返回可用的 `restorePoint`（卷快照/数据库备份标识），没有则拒绝 apply。
- 环境变量：只有登记白名单的变量；凭据由工具自行从系统环境/密钥链读取，不进入 plan、证据与模型上下文。
- 输出：stdout 只允许一个 JSON 对象，`{ ok, state, version, detail, steps?, restorePoint?,
  artifactSha256?, runningArtifactSha256?, runningPid?, runningStartedAt? }`；超过 64 KiB 截断。
  退出码 0 且 `ok: true` 且 `state` 合法才算成功；畸形输出、超时、非 0 退出都按失败记录原因。
- 上线核对证据：`status` 必须同时给出实际安装制品摘要 `artifactSha256` 与运行中制品摘要
  `runningArtifactSha256`，以及运行进程 `runningPid`。缺任一项按 `verify_failed` 收口，
  不写成 `verified`；版本号相同但摘要不同同样失败。
- 幂等：同一 `intentId` 重复调用 `apply`，工具应返回 `state: "noop"`；ForgeLoop 也会先
  `status` 观测，已是目标摘要就不再调用。
- 只读：`preflight`/`status`/`logs` 不得有副作用（契约要求，真实工具另做集成验证）。

安全约束（写进代码，不靠提示词）：

- `toolRoot` 默认为 ForgeLoop 的部署目录 `<recordsRoot>/projects/<project>/deployments/tools`，
  可配置但必须是部署目录 `<recordsRoot>/projects/<project>/deployments` 的子目录。
- 脚本路径必须是绝对路径、realpath 落在 `toolRoot` 内；拒绝指向 `toolRoot` 之外的符号链接。
- **脚本变更留痕**：装载期与每次调用前计算脚本 sha256，与上次记录不一致时写
  `deployment_tool_changes`（旧摘要、新摘要、时间、路径），本次调用的证据里记录实际执行的摘要。
  变更不阻断，但必须可回查。
- 模型不能提供脚本、参数、命令、设备地址；只能给 target id。
- 工具在宿主账户下运行，没有 OS 隔离；登记工具等于授权它执行部署，配置变更属于所有者决定。

## 4. 配置设计（装载期校验，非法即失败）

部署配置独立于 `ops`；运维只**引用** target。

```json
{
  "deployments": {
    "enabled": true,
    "verifyTimeoutSeconds": 600,
    "alerts": { "webhook": "https://example.com/deploy-alert" },
    "retention": { "days": 120, "compressEveryDays": 30, "maxBytes": 10737418240 },
    "tools": [
      {
        "id": "deploy-dsh",
        "kind": "python",
        "path": "<recordsRoot>/projects/<project>/deployments/tools/dsh_plugin.py",
        "capabilities": ["preflight", "apply", "status", "rollback", "data-rollback"],
        "timeoutSeconds": 300,
        "env": ["DSH_HOME"]
      }
    ],
    "targets": [
      {
        "id": "forgeloop-web",
        "toolId": "deploy-dsh",
        "requirementId": "req-20261029070230-bab6bf",
        "params": { "profile": "web" },
        "data": { "volumes": [], "migrations": [] },
        "approval": "auto",
        "autoDeliver": true,
        "rollback": { "keep": 2 }
      }
    ]
  },
  "ops": {
    "actions": [
      { "kind": "deploy", "id": "deploy-web", "resourceId": "web", "targetId": "forgeloop-web" }
    ]
  }
}
```

示例中的 `requirementId` 是 target 的默认需求；按应用复用 target 时可省略或留空，由每次 intent 指定需求。

校验规则：

- 工具 id、target id 唯一；`kind` 只能是 `python`/`shell`/`k8s`；脚本存在且 realpath 位于 `toolRoot` 内。
- `toolRoot` 省略时取部署目录下的 `tools/`；给了就必须是部署目录的子目录。
- target 的 `toolId` 必须存在；`requirementId` 可选，作为该目标的默认需求；为空或省略时，
  每次部署 intent 必须显式指定需求。`params` 只做结构校验（对象、字符串值、长度上限），语义由工具负责；
  `profile` 名仍做单段校验，拒绝 `.`、`..` 与分隔符。
- `approval` 只能是 `owner`（默认）或 `auto`。`auto` 必须同时满足：`rollback.keep ≥ 1`、
  `deployments.alerts.webhook` 非空（重载失败必须有告警去处）；声明了数据范围时工具具备 `data-rollback`。
- `autoDeliver` 默认 false。为 true 时，协调器在普通需求受控提交后自动构建，并按 target 的
  `approval` 自动 apply 或只创建等待批准的 intent；同一需求+候选+target 只交接一次，
  重启后按 `delivery_handoffs` 续跑。
- `data.volumes`/`data.migrations` 只接受字符串数组（标识与说明），不能写命令。
- `ops.actions[].kind=deploy` 只能引用已登记 target，不带命令与参数。
- `env` 只允许变量名，值从宿主环境读取；配置里不写秘密。
- 保留期：`days` 默认 120、`compressEveryDays` 默认 30（必须 ≤ `days`）、`maxBytes` 默认 10737418240（10 GiB）；
  `verifyTimeoutSeconds` 默认 600。
- **本版只允许 `transport: "local"`**；写 `ssh` 或多设备在装载期失败并说明“当前版本不支持多机部署”。

## 5. 授权模型（确定性代码，不靠提示词）

- **所有者入口**：看板认证动作 `deployment-intent` / `deployment-approve` / `deployment-rollback`
  （`by=config.owner`）；`deployment-intent` 接受可选的 `reqId`，省略时用 target 默认需求。
  模型工具不能调用。原 `deploy` 端点保留为“上线核对”，与部署执行分开。
- **自动执行**：`approval: "auto"` 允许用于正式 profile，但必须满足 §4 的三项条件；
  门禁仍全部校验，`auto` 只是免去逐次人工批准，不降低门槛。
- **运维提议**：运维 Agent 在事件诊断里只能输出 `proposed_deployment: { target_id }`；主控校验
  target 已登记、事件资源匹配、该事件未部署过；需求取事件已关联的修复需求，否则用 target 默认需求，
  两者都没有时拒绝并在事件观测中说明。再按 `approval` 决定自动执行或等待批准。
  提示词与工具不提供“直接部署”的参数。
- **门禁**（全满足才允许调用 `apply`）：需求当前版本、系统准入（有准入记录时）、未停止、已受控提交；
  候选已构建且 `artifact.sha256` 等于验证与业务终审绑定的摘要；独立验证通过；业务终审通过；
  intent 指定的需求与候选/验证/终审一致；声明了数据范围时 `preflight` 必须给出 `restorePoint`。
  **人类验收只对 `approval: "owner"` 目标必需**；`auto` 目标由 target 配置授权，系统交付判定不能
  被验收记录替代。target 的 `requirementId` 只是默认值，不是唯一允许部署的需求。
- **自动交接**：`autoDeliver` 目标按上述门禁推进；auto 目标 apply 后由协调器执行 `status` 核对，
  owner 目标停在 `awaiting_approval` 等真实决定。核对失败的 intent 不重试，等待人工/新候选。
- **运行身份**：核对比对安装摘要与运行摘要，任一与 intent 制品不符即 `verify_failed`；
  工具无法提供摘要时保持未验证。
- **回退**：保留 `keep` 份已验收产物；回退是一次新 intent，调用工具的 `rollback`（带 `restorePoint`），
  走同一状态机与核对。容器卷与数据库迁移按 target 声明的范围一并回退；回退后重新核对，
  不把“命令退出 0”当作数据已恢复。
- **失败告警**：`applied_pending_verify` 超过 `verifyTimeoutSeconds` 未收敛记为 `verify_failed`，
  向 `deployments.alerts.webhook` 发送一次告警（复用一次尽力发送，不重试）；回退可由所有者一键发起。

## 6. 设备与多机（本版不支持多机）

- 本版固定本机部署：不配置 `devices`，内部只有一个 `local` 设备；`transport` 只接受 `local`。
- 每台设备一条 attempt 的模型保留，但本版 attempt 只有一条，状态 `partial` 不会出现。
- 多机（设备表、ssh、canary/rolling、部分失败）留到后续版本；写 `ssh` 或多设备的配置在装载期失败，
  错误消息明确说明原因——能配置不等于已经支持。

## 7. 记录、证据与保留期

- 两张业务表：`deployment_intents`（target、requirement、artifact、来源、审批、状态）与
  `deployment_attempts`（intent、device、状态、退出码、结果 JSON、耗时、证据路径、toolSha256）。
- 工具脚本留痕：`deployment_tool_scripts`（当前摘要）与 `deployment_tool_changes`（变更历史）。
- 证据目录：`<recordsRoot>/projects/<project>/deployments/<intentId>/`，含 plan、
  preflight/apply/status 的 stdout 尾部与 stderr 摘要（有界），不含凭据。
- 与现有 `deployments` 表（上线核对）区分：核对是“装好之后证明”，attempt 是“装的过程与工具回执”；
  用 artifact sha256 与 target 关联。
- **保留期**：默认 120 天；每 30 天把过期证据目录压成 `evidence.tar.gz`（压缩后删除原文件）；
  超过保留期整目录删除；磁盘占用超过 `maxBytes` 时按最旧优先删除非进行中证据，并发送一次告警。
  进行中的 intent 证据永不清理；清理动作写记录，可在页面回查。
- 页面：部署目标列表（当前/上一版本、工具、审批方式）、进行中 intent、每设备状态、证据入口、
  批准/回退；运维视图只展示与事件关联的部署。
- 模型只读工具：`forgeloop_rollouts`（列表/详情，只读，不含执行参数）。

## 8. 验收标准

- 工具契约：用假 Python/shell 脚本覆盖成功、非 0 退出、超时、畸形 JSON、超大输出、幂等 noop、
  `status` 漂移、`rollback`、`data-rollback`、`restorePoint` 缺失；断言 ForgeLoop 不拼命令、
  不把工具 stdout 当指令。
- 授权：未批准不能 apply；模型工具无法触发；`auto` 只在满足三项条件时生效；摘要/验证/终审不一致时拒绝。
- 数据回退：声明卷/迁移但工具缺 `data-rollback` 时装载或调用失败；回退后核对实际状态，不只看退出码。
- 证据：保留期压缩与删除、超限按最旧清理、进行中证据不删、告警只发一次；脚本变更产生变更记录。
- 真实集成（按阶段）：python 工具装 DSH profile + 重载核对；k8s 工具对测试 namespace 做 apply/rollback；
  容器工具的本机卷回退。
- 不把工具回执当作部署成功；`verify_failed` 必须有告警与回退入口。

## 9. 分阶段实施

| 阶段 | 范围                                                                                         | 完成标志                                                                |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P0   | `deployments` 配置与工具契约、intent/attempt、证据与保留期、owner 批准、只读工具、假工具测试 | 用登记 python 工具装测试 profile → 重载 → 核对通过；未批准/摘要不符被拒 |
| P1   | 真实 `dsh-plugin` 工具脚本（python）、`auto` 与重载失败告警、回退位                          | 测试 profile 换版本并可回退；超时触发告警                               |
| P2   | `k8s` 工具（apply/rollback/status）、容器工具脚本、容器卷与数据库迁移回退                    | 测试 namespace 部署与回退；卷与迁移恢复后核对通过                       |
| 后续 | 多机设备、ssh、canary/rolling、更多工具类型                                                  | 单独立项                                                                |

## 10. 已确认决定（2026-11-03）

1. **工具信任根**：`toolRoot` 使用 ForgeLoop 的部署目录（默认 `<recordsRoot>/projects/<project>/deployments/tools`）；
   工具脚本的变更**必须记录**（摘要变更留痕，不阻断执行）。
2. **自动部署**：`auto` 允许用于正式 profile，但必须**保留回退产物**（`rollback.keep ≥ 1`）且
   **有重载失败告警**（`deployments.alerts.webhook` 非空）。
3. **多机**：当前版本不支持多机，只支持本机部署；写 ssh 或多设备在装载期失败。
4. **回退范围**：容器卷与数据库迁移纳入回退；工具需具备 `data-rollback` 并在 preflight 给出恢复点。
5. **证据**：保留期默认 120 天，每 30 天压缩；磁盘占用上限默认 10 GiB；两者均可配置。

仍需确认的小项：

- 重载失败后是否要自动回退？当前设计只告警 + 一键回退，不自动执行。
- 工具脚本变更只记录不审批；是否需要在变更后强制一次人工确认才能下次部署？

## 11. 实施文件清单（P0，待确认后执行）

- `packages/forgeloop/src/domain/deployment.ts`：类型、工具描述符、状态机、门禁判定、结果 JSON 解析。
- `packages/forgeloop/src/runtime/deployment-tools.ts`：工具登记表、调用协议、超时/输出上限、脚本摘要。
- `packages/forgeloop/src/runtime/deployments.ts`：协调器、intent/attempt、审批、状态机。
- `packages/forgeloop/src/runtime/deployment-maintenance.ts`：证据压缩、保留期与磁盘上限清理。
- `packages/forgeloop/src/records/deployment-store.ts`：表结构、intent/attempt、工具摘要与变更记录。
- `packages/forgeloop/src/config.ts`：`deployments` 配置与装载期校验。
- `packages/forgeloop/src/tools.ts`：只读 `forgeloop_rollouts`；运维提案仍走诊断 JSON，不给执行工具。
- `packages/forgeloop/src/runtime/{ops.ts,ops-monitor.ts,prompts.ts}`：诊断 `proposed_deployment` 与门禁。
- `packages/forgeloop/src/runtime/board-route.ts`、`client.js`：目标列表、批准/回退与证据。
- 测试：`tests/deployment-config.test.ts`、`tests/deployment-tools.test.ts`、
  `tests/deployment-run.test.ts`、`tests/deployment-retention.test.ts`、`tests/ops-deployment.test.ts`。
- 文档：本文件、`docs/architecture.md`、`docs/ops-agent.md`、`docs/deployment.md`、`docs/status.md`。
