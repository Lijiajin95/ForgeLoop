# forgeloop-dsh

ForgeLoop 的 TypeScript 原生 DSH 插件：把需求受理、分析/规划、人类批准、独立审查、
正式测试、交付证据与持久推进放进 DSH 宿主进程。运行期不依赖 Python 或独立 HTTP 服务。

## 安装

```sh
dsh plugin --profile <name> add /path/to/packages/forgeloop
dsh --profile <name> --dump-config   # 应出现 "# == forgeloop-dsh" 层
```

随后在该 profile 的 `cordis.patch.yml` 里覆盖 `forgeloop` 行的 `recordsRoot`、`project`、
`projectPath` 与 `agent.provider/model`。记录根布局与旧版兼容：
`<recordsRoot>/projects/<project>/records.sqlite`。

## 入口

人类命令：`/fl help`（提交、修订、分析、规划、批准、推进、验收、停止、取消、取证）。

模型工具：`forgeloop_status`、`forgeloop_show_requirement`、`forgeloop_show_plan`、
`forgeloop_evidence`、`forgeloop_requests`、`forgeloop_impact`、`forgeloop_submit_requirement`。
批准/验收/推进/停止不在工具中暴露，只能从人类命令入口触发。

Web 页面：DSH Web 会话区「天工」页（与「对话」「轨迹」并列），展示需求、任务与待处理问题的
当前状态。页面只读，数据经宿主认证路由 `/api/forgeloop/board` 取得；没有批准、推进或验收
入口。没有浏览器连接服务的 profile（headless）不会注册该路由。

输入框工具行提供工作流选择：DSH 按普通对话处理；ForgeLoop 让草稿保持在 `/fl submit ` 前缀下，
把消息作为需求受理，批准与验收仍从 `/fl` 进入。

## 验证

```sh
npm run check --workspace forgeloop-dsh
```

## 本地候选包

```sh
npm run candidate --workspace forgeloop-dsh
```
