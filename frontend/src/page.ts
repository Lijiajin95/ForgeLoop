/**
 * 页面装配：把元素句柄、页签、渲染与轮询接起来。
 *
 * 只做接线，不含业务规则（格式化在 format.ts、身份关联在 link.ts、渲染在
 * render.ts、页签与跳转在 tabs.ts、调度在 progress.ts）。把 `Document` 与取数实现
 * 作为参数传入，测试就能把**真实的页面 HTML** 交给它，从而在快速层核对
 * 「HTML 的元素 id 与脚本一致」这条契约。
 *
 * 跨段跳转也在这里合拢：渲染层只声明「去哪一段的哪个对象」，实际切换与高亮由
 * `tabs.ts` 落到 DOM 上；自动刷新重绘内容不会重置当前页签。
 */

import {
  actionRequest,
  forgetSubmitKey,
  loadSubmitKey,
  newClientKey,
  operationsAvailable,
  rememberSubmitKey,
  performOperation,
  readToken,
  submitRequest,
  type OperationFetcher,
  type OperationOutcome,
  type OperationRequest,
} from "./actions.js";
import { PanelClient, type ProjectDraft } from "./panel.js";
import {
  PANEL_TABS,
  fillProjectForm,
  renderPanelAvailability,
  renderPanelDocument,
  renderPanelSessionDetail,
  renderPanelStatus,
  renderPanelTab,
  resolvePanelElements,
  type PanelElements,
} from "./panel_render.js";
import { PROGRESS_URL, type PanelDocument, type RequirementAction } from "./payload.js";
import { ProgressClient, type ProgressFetcher } from "./progress.js";
import { createCollapseState, resolveElements } from "./dom.js";
import {
  clearError,
  renderOperationStatus,
  renderOperationsAvailability,
  renderProgress,
  showError,
} from "./render.js";
import { focusTarget, resolveTabs, wireTabs } from "./tabs.js";

/** 装配依赖：默认用真实 fetch 与真实时钟，测试可注入。 */
export interface BootstrapOptions {
  readonly fetcher?: ProgressFetcher;
  readonly now?: () => number;
  /** 写请求实现（默认真实 `fetch`）；测试注入替身，避免真实网络。 */
  readonly operationFetcher?: OperationFetcher;
}

/** 解析元素、接上页签与事件并启动轮询；返回客户端供测试等待与断言。 */
export function bootstrap(document: Document, options: BootstrapOptions = {}): ProgressClient {
  const elements = resolveElements(document);
  const tabs = resolveTabs(document);
  // 折叠状态随装配建立一次：自动刷新重绘内容不会把用户的展开／收起选择抹掉。
  const collapse = createCollapseState();
  const client = new ProgressClient({
    url: PROGRESS_URL,
    onDocument: (progress) => {
      clearError(elements);
      renderProgress(
        elements,
        progress,
        {
          goTo: (tab, refId) => {
            focusTarget(tabs, tab, refId);
          },
        },
        collapse,
      );
    },
    onError: (message) => {
      showError(elements, message);
    },
    onCountdown: (message) => {
      elements.countdown.textContent = message;
    },
    ...options,
  });
  elements.refreshButton.addEventListener("click", () => {
    client.manualRefresh();
  });
  wireTabs(tabs);
  wireOperations(elements, client, options.operationFetcher);
  client.start();
  return client;
}

/**
 * 装配右侧对话框面板：元素解析、可见性、事件接线与轮询启动。
 *
 * 与 `bootstrap` 分开装配：进展视图与对话框面板互不依赖，真实入口（`app.ts`）两个都装，
 * 测试可以只装其中一个而不被另一个的取数打扰。
 *
 * 返回 `undefined` 表示当前入口不提供写权限（`forgeloop web` 只读服务不下发令牌），
 * 此时面板整体隐藏——页面不去发一个必然被拒的请求。
 */
export function bootstrapPanel(
  document: Document,
  options: BootstrapOptions = {},
): PanelClient | undefined {
  const elements = resolvePanelElements(document);
  const token = readToken(document);
  const available = operationsAvailable(token);
  renderPanelAvailability(elements, available);
  if (!available) {
    return undefined;
  }
  let latest: PanelDocument | undefined;
  const client = new PanelClient({
    token,
    ...(options.operationFetcher === undefined ? {} : { fetcher: options.operationFetcher }),
    onDocument: (panelDocument) => {
      latest = panelDocument;
      renderPanelDocument(elements, panelDocument, client.selectedSessionId);
    },
    onSession: (detail) => {
      renderPanelSessionDetail(elements, detail);
    },
    onStatus: (message, tone) => {
      renderPanelStatus(elements, message, tone);
    },
    onSelected: (sessionId) => {
      if (latest !== undefined) {
        renderPanelDocument(elements, latest, sessionId);
      }
    },
  });
  wirePanel(elements, client, () => latest);
  client.start();
  return client;
}

/** 面板状态提示：本地校验失败（缺理由、命令不是 JSON 数组）也走同一行。 */
function panelNotice(elements: PanelElements, message: string): void {
  renderPanelStatus(elements, message, "error");
}

/** 页签按钮接线：点击切换视图（按钮与页签一一对应，取不到就忽略）。 */
function wirePanelTabs(elements: PanelElements): void {
  elements.tabs.forEach((button, index) => {
    const tab = PANEL_TABS[index];
    button.addEventListener("click", () => {
      if (tab !== undefined) {
        renderPanelTab(elements, tab);
      }
    });
  });
}

/** 新建会话：先校验必填，再调用写入口。 */
function wireNewSession(elements: PanelElements, client: PanelClient): void {
  elements.newSessionButton.addEventListener("click", () => {
    elements.newSessionForm.hidden = false;
    elements.sessionTitle.focus();
  });
  elements.cancelSessionButton.addEventListener("click", () => {
    elements.newSessionForm.hidden = true;
  });
  elements.createSessionButton.addEventListener("click", () => {
    const project = elements.projectSelect.value;
    const title = elements.sessionTitle.value.trim();
    if (project === "" || title === "") {
      panelNotice(elements, "新建会话需要项目与标题。");
      return;
    }
    client
      .createSession(project, title)
      .then((outcome) => {
        if (outcome.ok) {
          elements.sessionTitle.value = "";
          elements.newSessionForm.hidden = true;
        }
      })
      .catch(() => undefined); // 失败已渲染成状态行
  });
}

/** 发送与终止：都要求选中会话；终止还要求理由（理由会写进记录）。 */
function wireComposer(elements: PanelElements, client: PanelClient): void {
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.messageText.value.trim();
    if (text === "") {
      panelNotice(elements, "消息内容不能为空。");
      return;
    }
    client
      .send(text)
      .then((outcome) => {
        if (outcome.ok) {
          elements.messageText.value = "";
        }
      })
      .catch(() => undefined);
  });
  elements.terminateButton.addEventListener("click", () => {
    const reason = elements.reason.value.trim();
    if (reason === "") {
      panelNotice(elements, "终止会话必须填写理由。");
      return;
    }
    client.terminate(reason).catch(() => undefined);
  });
}

/** 待人工决定：按钮带 data-decision／data-choice，理由与补充指令取表单输入。 */
function wireDecisions(elements: PanelElements, client: PanelClient): void {
  elements.decisions.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    const decisionId = button?.dataset["decision"] ?? "";
    const choice = button?.dataset["choice"] ?? "";
    if (decisionId === "" || (choice !== "approve" && choice !== "reject")) {
      return;
    }
    const reason = elements.reason.value.trim();
    if (reason === "") {
      panelNotice(elements, "作出人工决定必须填写理由。");
      return;
    }
    client
      .decide(decisionId, choice, reason, elements.decisionText.value.trim())
      .then((outcome) => {
        if (outcome.ok) {
          elements.decisionText.value = "";
        }
      })
      .catch(() => undefined);
  });
}

/** 把表单里的 PI 命令解析成 argv 数组；不合法就明确报错，不猜怎么拆词。 */
function parseCommand(raw: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

/** 从表单读出一份项目草稿；必填缺失或命令不是 argv 数组时返回 `undefined`。 */
function readProjectDraft(elements: PanelElements): ProjectDraft | undefined {
  const command = parseCommand(elements.projectCommand.value.trim());
  const draft: ProjectDraft = {
    name: elements.projectName.value.trim(),
    path: elements.projectPath.value.trim(),
    description: elements.projectDescription.value.trim(),
    piCommand: command ?? [],
    piHome: elements.projectHome.value.trim(),
  };
  if (draft.name === "" || draft.path === "" || draft.piHome === "" || command === undefined) {
    return undefined;
  }
  return draft;
}

/** 项目表单：新增或保存修改（编辑目标记在提交按钮的 dataset 上）。 */
function wireProjectForm(elements: PanelElements, client: PanelClient): void {
  elements.projectReset.addEventListener("click", () => {
    fillProjectForm(elements, undefined);
  });
  elements.projectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = readProjectDraft(elements);
    if (draft === undefined) {
      panelNotice(
        elements,
        '项目名、路径、隔离 HOME 必填；PI 命令必须是 JSON 字符串数组（例如 ["pi","--mode","rpc"]）。',
      );
      return;
    }
    const editing = elements.projectSubmit.dataset["editing"] ?? "";
    const action =
      editing === "" ? client.createProject(draft) : client.updateProject(editing, draft);
    action
      .then((outcome) => {
        if (outcome.ok) {
          fillProjectForm(elements, undefined);
        }
      })
      .catch(() => undefined);
  });
}

/** 项目表：行内「编辑」回填表单，「删除」要求理由（进行中会话会被服务端拒绝）。 */
function wireProjectRows(
  elements: PanelElements,
  client: PanelClient,
  latestDocument: () => PanelDocument | undefined,
): void {
  const editProject = (name: string): void => {
    const project = latestDocument()?.projects.find((item) => item.name === name);
    if (project !== undefined) {
      fillProjectForm(elements, project);
    }
  };
  const removeProject = (name: string): void => {
    const reason = elements.reason.value.trim();
    if (reason === "") {
      panelNotice(elements, "删除项目必须填写理由（写在表单的「理由」输入框）。");
      return;
    }
    client.removeProject(name, reason).catch(() => undefined);
  };
  elements.projectsBody.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    const name = button?.dataset["project"] ?? "";
    const action = button?.dataset["action"] ?? "";
    if (name === "") {
      return;
    }
    if (action === "edit") {
      editProject(name);
      return;
    }
    if (action === "remove") {
      removeProject(name);
    }
  });
}

/** 面板事件总装：页签、会话选择与刷新、新建会话、发送/终止、决定、项目增删改。 */
function wirePanel(
  elements: PanelElements,
  client: PanelClient,
  latestDocument: () => PanelDocument | undefined,
): void {
  wirePanelTabs(elements);
  wireNewSession(elements, client);
  wireComposer(elements, client);
  wireDecisions(elements, client);
  wireProjectForm(elements, client);
  wireProjectRows(elements, client, latestDocument);
  elements.refreshButton.addEventListener("click", () => {
    client.refreshPanel().catch(() => undefined);
  });
  elements.sessionList.addEventListener("change", () => {
    const sessionId = elements.sessionList.value;
    if (sessionId === "") {
      return;
    }
    client.openSession(sessionId).catch(() => undefined);
  });
}

/** 需要理由的三类人工决定：与 `cli/serve.py` 的 `reason_required` 一致。 */
const REASON_REQUIRED: readonly RequirementAction[] = ["approve", "accept", "stop", "cancel"];

/** action → 按钮元素，避免在事件回调里做字符串分支。 */
function actionButton(
  elements: ReturnType<typeof resolveElements>,
  action: RequirementAction,
): HTMLButtonElement {
  switch (action) {
    case "approve":
      return elements.actionApprove;
    case "advance":
      return elements.actionAdvance;
    case "accept":
      return elements.actionAccept;
    case "cancel":
      return elements.actionCancel;
    default:
      return elements.actionStop;
  }
}

/** 写请求期间禁用全部按钮：避免同一决定被连点两次。 */
function setBusy(elements: ReturnType<typeof resolveElements>, busy: boolean): void {
  for (const button of [
    elements.submitButton,
    elements.actionApprove,
    elements.actionAdvance,
    elements.actionAccept,
    elements.actionStop,
    elements.actionCancel,
  ]) {
    button.disabled = busy;
  }
}

/** 发一次写请求并把结果渲染成状态行；成功后回读一次进展。 */
async function dispatchOperation(
  elements: ReturnType<typeof resolveElements>,
  client: ProgressClient,
  token: string,
  request: OperationRequest,
  fetcher?: OperationFetcher,
): Promise<OperationOutcome> {
  setBusy(elements, true);
  let outcome: OperationOutcome;
  try {
    outcome = await performOperation(request, token, fetcher);
  } finally {
    setBusy(elements, false);
  }
  renderOperationStatus(elements, outcome.message, outcome.ok ? "info" : "error");
  if (outcome.ok) {
    // 写成功后立刻回读一次，让人工看到自己那一步的结果，而不是等下一个刷新周期。
    elements.submitText.value = "";
    client.manualRefresh();
  }
  return outcome;
}

/** 会话存储：某些环境（沙箱 iframe、隐私模式）连读取属性都会抛错，因此包一层。 */
function sessionKeyStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** 提交表单接线：项目与正文都非空才发；幂等键在一次成功之前保持不变。 */
function wireSubmit(
  elements: ReturnType<typeof resolveElements>,
  client: ProgressClient,
  token: string,
  fetcher?: OperationFetcher,
): void {
  const storage = sessionKeyStorage();
  // 刷新页面后复用同一个键：服务端因此不会把「重试」当成新提交。
  let submitKey = loadSubmitKey(storage) || newClientKey();
  rememberSubmitKey(storage, submitKey);
  elements.submitForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const project = elements.submitProject.value.trim();
    const text = elements.submitText.value.trim();
    if (project.length === 0 || text.length === 0) {
      renderOperationStatus(elements, "提交需求需要项目与正文。", "error");
      return;
    }
    dispatchOperation(
      elements,
      client,
      token,
      submitRequest(
        project,
        text,
        elements.operationsBy.value,
        elements.submitReason.value,
        submitKey,
      ),
      fetcher,
    )
      .then((outcome) => {
        // 失败/重试复用同一个键（服务端按它去重），成功后才换新键。
        if (outcome.ok) {
          submitKey = newClientKey();
          rememberSubmitKey(storage, submitKey);
          forgetSubmitKey(storage);
        }
      })
      .catch(() => undefined); // dispatchOperation 内部已把失败渲染成状态行
  });
}

/**
 * 接上操作面板：只有拿到令牌时才显示，提交与四类动作都发同一种写请求。
 *
 * 页面能做的校验只有「必填项为空就先别发」——真正的判定（绑定、幂等、理由、范围）
 * 都在服务端，页面把拒绝原因原样显示，不自己解释成别的结论。
 */
function wireOperations(
  elements: ReturnType<typeof resolveElements>,
  client: ProgressClient,
  fetcher?: OperationFetcher,
): void {
  const document = elements.operations.ownerDocument;
  const token = readToken(document);
  renderOperationsAvailability(elements, operationsAvailable(token));
  if (!operationsAvailable(token)) {
    return;
  }

  wireSubmit(elements, client, token, fetcher);

  for (const action of ["approve", "advance", "accept", "stop", "cancel"] as const) {
    actionButton(elements, action).addEventListener("click", () => {
      const reqId = elements.actionReq.value;
      const reason = elements.actionReason.value.trim();
      if (reqId.length === 0) {
        renderOperationStatus(elements, "先选择一条需求。", "error");
        return;
      }
      if (REASON_REQUIRED.includes(action) && reason.length === 0) {
        renderOperationStatus(elements, `${action} 需要填写理由。`, "error");
        return;
      }
      dispatchOperation(
        elements,
        client,
        token,
        actionRequest(reqId, action, elements.operationsBy.value, reason),
        fetcher,
      ).catch(() => undefined);
    });
  }
}
