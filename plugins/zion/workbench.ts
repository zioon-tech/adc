const PLUGIN_ID = "dev.agent-device-cloud";

export async function activate(ctx: any) {
  const zion = (window as any).zion;
  const zh = navigator.language.startsWith("zh");
  const text = (en: string, cn: string) => (zh ? cn : en);
  let container: HTMLElement | undefined, state: any, statusItem: any;
  let disposed = false,
    revision = 0;
  const requests = new Set<AbortController>();
  const subscriptions = ctx.subscriptions ?? [];
  function activeSession() {
    const panel = zion.panels
      ?.list?.()
      .find((item: any) => item.id === zion.panels?.getActivePanelId?.());
    return String(panel?.activeTabId || zion.state?.get?.("sessions.currentId") || "");
  }
  function runtimeUrl() {
    if (
      (zion.state?.get?.("runtime.mode") ?? localStorage.getItem("zion.runtime.mode")) === "browser"
    )
      throw new Error(text("Connect Zion Runtime first.", "请先连接 Zion Runtime。"));
    return String(
      zion.state?.get?.("runtime.baseUrl") ||
        localStorage.getItem("zion.runtime.baseUrl") ||
        (location.protocol === "https:" ? location.origin : "http://127.0.0.1:8766")
    ).replace(/\/+$/, "");
  }
  async function command(args: Record<string, unknown>) {
    const sessionId = activeSession();
    if (!sessionId) throw new Error(text("Open a conversation first.", "请先打开一个会话。"));
    const controller = new AbortController();
    requests.add(controller);
    try {
      const response = await fetch(`${runtimeUrl()}/v1/plugins/${PLUGIN_ID}/commands`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)]),
        body: JSON.stringify({ ...args, sessionId })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "ADC connection unavailable");
      return body.result;
    } finally {
      requests.delete(controller);
    }
  }
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string) {
    const item = document.createElement(tag);
    if (value) item.textContent = value;
    return item;
  }
  function action(parent: HTMLElement, label: string, operation: () => Promise<unknown>) {
    const button = element("button", label);
    button.type = "button";
    button.onclick = async () => {
      button.disabled = true;
      try {
        await operation();
      } catch (error) {
        state = { ...state, message: (error as Error).message };
        render();
      } finally {
        button.disabled = false;
      }
    };
    parent.append(button);
  }
  function link(parent: HTMLElement, label: string, href: string) {
    const anchor = element("a", label);
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    parent.append(anchor);
  }
  function render() {
    if (!container || disposed) return;
    container.replaceChildren();
    container.classList.add("adc-sidebar");
    const heading = element("header");
    heading.append(
      element("strong", "ADC"),
      element(
        "span",
        state?.connected ? text("Connected", "已连接") : text("Connection required", "待连接")
      )
    );
    container.append(heading);
    if (state?.message) {
      const message = element("p", state.message);
      message.setAttribute("role", "status");
      container.append(message);
    }
    const actions = element("nav");
    if (!state?.connected) {
      action(actions, text("Connect ADC", "连接 ADC"), async () => {
        const callback = new URL(location.href);
        callback.search = "";
        callback.hash = "";
        const result = await command({ action: "connect", redirectUri: callback.href });
        location.assign(result.authorizeUrl);
      });
    } else
      action(actions, text("Disconnect", "断开连接"), async () => {
        await command({ action: "disconnect" });
        await refresh();
      });
    action(actions, text("Refresh", "刷新"), refresh);
    container.append(actions);
    if (state?.connected) {
      container.append(element("p", state.access || "ADC"));
      const label = element("label", text("Device", "设备"));
      const select = element("select");
      select.setAttribute("aria-label", text("Choose device", "选择设备"));
      const placeholder = element("option", text("Choose device", "选择设备"));
      placeholder.value = "";
      select.append(placeholder);
      for (const device of state.devices ?? []) {
        const option = element(
          "option",
          `${device.label} · ${device.platform} · ${device.online ? text("online", "在线") : text("offline", "离线")}`
        );
        option.value = device.nodeId;
        select.append(option);
      }
      select.value = state.selectedNodeId ?? "";
      select.onchange = async () => {
        if (!select.value) return;
        try {
          await command({ action: "select", nodeId: select.value });
          await refresh();
        } catch (error) {
          state.message = (error as Error).message;
          render();
        }
      };
      label.append(select);
      container.append(label);
      const selected = state.devices?.find((device: any) => device.nodeId === state.selectedNodeId);
      if (selected) {
        const roots = element("ul");
        for (const root of selected.roots ?? [])
          roots.append(element("li", root.path ?? root.label ?? root.rootId));
        if (roots.childElementCount) container.append(roots);
      }
      if (!state.devices?.length)
        container.append(
          element(
            "p",
            text(
              "No devices are authorized yet. Add a device and update this connection's access.",
              "尚未授权设备。接入设备后，请更新此连接的授权。"
            )
          )
        );
    }
    const links = element("nav");
    if (state?.links) {
      link(links, text("Set up devices", "接入设备"), state.links.devices);
      link(links, text("Authorization settings", "授权设置"), state.links.access);
      link(links, text("Review approvals", "查看审批"), state.links.approvals);
    }
    container.append(links, element("h3", text("Tasks", "任务")));
    if (!state?.tasks?.length)
      container.append(
        element("p", text("No ADC tasks in this connection.", "此连接暂无 ADC 任务。"))
      );
    for (const task of state?.tasks ?? []) {
      const details = element("details");
      details.append(element("summary", `${task.status} · ${task.jobId ?? task.invocationId}`));
      if (task.reviewUrl) link(details, text("Review approval", "审批此操作"), task.reviewUrl);
      details.append(
        element("pre", JSON.stringify(task.receipt ?? task.output ?? task.error ?? {}, null, 2))
      );
      container.append(details);
    }
  }
  async function refresh() {
    const current = ++revision;
    try {
      const next = await command({ action: "status" });
      if (disposed || current !== revision) return;
      state = next;
    } catch (error) {
      if (disposed || current !== revision) return;
      state = { connected: false, message: (error as Error).message };
    }
    render();
    statusItem?.dispose?.();
    statusItem = zion.bottomStatusBar?.registerItem?.({
      id: "adc.status",
      text: state?.connected ? "ADC" : text("ADC · connect", "ADC · 待连接"),
      tooltip: text("ADC devices and tasks", "ADC 设备与任务"),
      priority: 55,
      onClick: () => zion.sideBar?.showView?.("adc.devices")
    });
  }
  subscriptions.push(
    zion.sideBar.registerView({
      id: "adc.devices",
      pluginId: PLUGIN_ID,
      title: "ADC",
      icon: "$(remote)",
      order: 45,
      location: "sidebar",
      component: {
        render(node: HTMLElement) {
          container = node;
          render();
          void refresh();
        }
      }
    })
  );
  subscriptions.push(
    zion.activityBar.registerItem({
      id: "adc.activity",
      pluginId: PLUGIN_ID,
      icon: "$(remote)",
      tooltip: "ADC",
      sideBarViewId: "adc.devices",
      order: 45
    })
  );
  for (const [name, handler] of Object.entries({
    "adc.refresh": refresh,
    "adc.open": () => zion.sideBar?.showView?.("adc.devices")
  }))
    subscriptions.push(zion.commands.registerCommand(name, handler));
  for (const event of ["sessions/changed", "chat/runFinished", "runtime/sessionRunEvent"])
    subscriptions.push(
      zion.events?.on?.(event, () => {
        void refresh();
      })
    );
  const onFocus = () => {
    void refresh();
  };
  window.addEventListener("focus", onFocus);
  subscriptions.push({
    dispose() {
      disposed = true;
      for (const request of requests) request.abort();
      statusItem?.dispose?.();
      container?.replaceChildren();
      window.removeEventListener("focus", onFocus);
    }
  });
  // The same-origin Workbench completes OAuth; tokens never pass through this module.
  const callback = new URL(location.href);
  if (
    callback.searchParams.get("state")?.startsWith("adc_") &&
    (callback.searchParams.has("code") || callback.searchParams.has("error"))
  ) {
    const code = callback.searchParams.get("code"),
      stateValue = callback.searchParams.get("state");
    for (const field of ["code", "state", "error", "error_description", "iss"])
      callback.searchParams.delete(field);
    history.replaceState(null, "", callback.href);
    try {
      if (!code) throw new Error(text("ADC sign-in was cancelled.", "ADC 登录已取消。"));
      await command({ action: "finish", code, state: stateValue });
    } catch (error) {
      state = { connected: false, message: (error as Error).message };
      render();
    }
  }
  void refresh();
  return {};
}
