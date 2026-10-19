/**
 * 前端测试夹具：真实页面 HTML 与示例进展快照。
 *
 * 页面 HTML 直接读**随包分发的那一份**（`src/forgeloop/cli/web_page.html`），
 * 因此「脚本要的元素 id 是否真的存在」是在核对真实产物，而不是核对一份复制品。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  IssueEntry,
  PanelDecision,
  PanelDocument,
  PanelMessage,
  PanelProjectEntry,
  PanelSessionDetail,
  PanelSessionSummary,
  PanelToolCall,
  ProgressDocument,
  RequirementEntry,
  TaskEntry,
} from "../../src/payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 随包分发的页面 HTML 路径。 */
const PAGE_HTML_PATH = resolve(HERE, "../../../src/forgeloop/cli/web_page.html");

/**
 * 把真实页面的 `<body>` 装进当前 jsdom 文档；返回装好的 body 元素数。
 */
export function loadPageBody(): number {
  const html = readFileSync(PAGE_HTML_PATH, "utf8");
  const start = html.indexOf("<body>") + "<body>".length;
  const end = html.indexOf("</body>");
  document.body.innerHTML = html.slice(start, end);
  return document.body.querySelectorAll("*").length;
}

/** 一条需求：默认已批准、两个任务交付一个。 */
/**
 * 在 jsdom 的 `<head>` 里放一个与真实页面同名的令牌 meta。
 *
 * `loadPageBody()` 只装 `<body>`，因此这里显式补上服务端注入点；「真实页面确实带这个
 * meta（占位形式）」由 Python 侧的页面契约用例核对。
 */
export function installTokenMeta(content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "forgeloop-token");
  meta.setAttribute("content", content);
  document.head.append(meta);
  document.body.append(document.createElement("div"));
}

export function sampleRequirement(overrides: Partial<RequirementEntry> = {}): RequirementEntry {
  return {
    req_id: "req-forgeloop-1",
    project: "forgeloop",
    requirement_status: "plan_proposed",
    plan: { plan_version: 1 },
    tasks: [{ state: "delivered" }, { state: "awaiting_user" }],
    next_step: { action: "批准或重新生成任务包", actor: "user" },
    blocked_reason: "",
    blocked_reason_text: "未找到该需求的任务包批准；未批准不执行",
    ...overrides,
  };
}

/** 一条任务：默认为阻断态（会被页面标红并出现在问题段）。 */
export function sampleTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    task_id: "task-blocked",
    project: "forgeloop",
    status: "blocked",
    next_action: { action: "人工核对批准绑定", actor: "user" },
    failures: {
      cumulative: 1,
      remaining_in_current_grant: 2,
      awaiting_grant_decision: false,
    },
    budget: { consumed_seconds: 125, limit_seconds: 7200 },
    blocked_reason_text: "任务需要人工核对现场（状态：blocked）",
    ...overrides,
  };
}

/** 一条问题项。 */
export function sampleIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    kind: "task_blocked",
    ref_id: "task-blocked",
    summary: "任务执行被阻断，需人工核对后才能继续",
    detail: "任务需要人工核对现场（状态：blocked）",
    ...overrides,
  };
}

/** 一份进展快照：默认含一条需求、一条阻断任务与一条问题。 */
export function sampleDocument(overrides: Partial<ProgressDocument> = {}): ProgressDocument {
  const requirements = overrides.requirements ?? [sampleRequirement()];
  const tasks = overrides.tasks ?? [sampleTask()];
  const issues = overrides.issues ?? [sampleIssue()];
  return {
    schema_version: 1,
    generated_at: "2026-10-17T04:00:00+00:00",
    records_root: "/tmp/records",
    refresh_seconds: 60,
    refresh_source: "config",
    counts: {
      requirements: requirements.length,
      tasks: tasks.length,
      issues: issues.length,
    },
    requirements,
    tasks,
    issues,
    ...overrides,
  };
}

/** 一个运行时已就绪的项目档案。 */
export function sampleProject(overrides: Partial<PanelProjectEntry> = {}): PanelProjectEntry {
  return {
    name: "forgeloop",
    path: "/home/link/Project/ForgeLoop",
    description: "ForgeLoop 自身",
    source: "panel",
    editable: true,
    is_git_repo: true,
    problems: [],
    live_sessions: 0,
    runtime: {
      ready: true,
      problems: [],
      pi_command: ["pi", "--mode", "rpc", "--no-session"],
      pi_home: "/home/link/.local/share/forgeloop/pi-home",
      running_turns: 0,
    },
    ...overrides,
  };
}

/** 一条会话摘要。 */
export function sampleSession(overrides: Partial<PanelSessionSummary> = {}): PanelSessionSummary {
  return {
    session_id: "cs-20261018120000-abcdef",
    project: "forgeloop",
    title: "排查构建失败",
    status: "active",
    created_at: "2026-10-18T12:00:00+00:00",
    updated_at: "2026-10-18T12:01:00+00:00",
    turn_count: 1,
    last_error: "",
    terminated_by: "",
    terminate_reason: "",
    message_count: 2,
    pending_decisions: 0,
    compaction_count: 0,
    running: false,
    ...overrides,
  };
}

/** 一条会话消息。 */
function sampleMessage(overrides: Partial<PanelMessage> = {}): PanelMessage {
  return {
    message_id: 1,
    role: "human",
    content: "看一下测试为什么失败",
    state: "ok",
    created_at: "2026-10-18T12:00:30+00:00",
    author: "owner",
    context_mode: "cold",
    ...overrides,
  };
}

/** 一次工具调用（默认：执行类、已跑完、待人工审批）。 */
export function sampleToolCall(overrides: Partial<PanelToolCall> = {}): PanelToolCall {
  return {
    tool_call_id: "call-1",
    tool_name: "bash",
    args_excerpt: '{"command": "ls -la"}',
    result_excerpt: "total 12",
    risk: "execute",
    status: "ok",
    duration_ms: 8,
    requires_approval: true,
    approval_status: "pending",
    started_at: "2026-10-18T12:00:35+00:00",
    ended_at: "2026-10-18T12:00:36+00:00",
    ...overrides,
  };
}

/** 一条待人工决定。 */
export function sampleDecision(overrides: Partial<PanelDecision> = {}): PanelDecision {
  return {
    decision_id: "dc-20261018120000-123456",
    kind: "agent_request",
    question: "是否删除旧接口？",
    status: "pending",
    created_at: "2026-10-18T12:00:40+00:00",
    decided_by: "",
    reason: "",
    ...overrides,
  };
}

/** 面板总览：默认一个就绪项目与一条会话。 */
export function samplePanelDocument(overrides: Partial<PanelDocument> = {}): PanelDocument {
  const projects = overrides.projects ?? [sampleProject()];
  const sessions = overrides.sessions ?? [sampleSession()];
  return {
    schema_version: 1,
    generated_at: "2026-10-18T12:01:00+00:00",
    projects,
    runtime: {
      concurrency: 2,
      turn_timeout_seconds: 900,
      running_turns: 0,
      queued_turns: 0,
      tool_approval: "write",
      live_sessions: 0,
    },
    sessions,
    ...overrides,
  };
}

/** 会话详情：默认一问一答。 */
export function sampleSessionDetail(
  overrides: Partial<PanelSessionDetail> = {},
): PanelSessionDetail {
  const session = overrides.session ?? sampleSession();
  const messages = overrides.messages ?? [
    sampleMessage(),
    sampleMessage({
      message_id: 2,
      role: "agent",
      content: "已完成：新增了两个测试。",
      author: "",
    }),
  ];
  return {
    schema_version: 1,
    generated_at: "2026-10-18T12:01:00+00:00",
    session,
    messages,
    decisions: overrides.decisions ?? [],
    tool_calls: overrides.tool_calls ?? [],
    ...overrides,
  };
}
