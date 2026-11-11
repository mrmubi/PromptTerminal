/* global Terminal, FitAddon, SearchAddon, SerializeAddon, WebLinksAddon */
"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const host = window.chrome?.webview;
  const panes = new Map();
  const tabs = new Map();
  const requests = new Map();
  const runtimes = new Map();
  const splitterRects = new Map();
  const paneRects = new Map();
  const workspaceMutations = new Set([
    "newTab", "renameTab", "reorderTab", "selectTab", "closeTab", "duplicateTab", "addPane", "splitPane",
    "editPane", "focusPane", "closePane", "toggleFloat", "dockPane", "movePane", "resizeSplit",
    "floatingBounds", "readOnly", "settings", "saveProfile", "deleteProfile", "saveSnippet",
    "deleteSnippet", "saveTemplate", "applyTemplate", "deleteTemplate"
  ]);
  let pendingWorkspaceMutation = null;
  let state;
  let drag;
  let frame = 0;
  let fitFrame = 0;
  let dialogSubmit;
  let dialogCleanup;
  let refreshSchedules;
  let lastTerminalFocus = false;
  let settingsKey = "";
  const gap = 8;
  const inset = 10;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, action, paneId, className = "") {
    const node = element("button", className, text);
    node.type = "button";
    node.dataset.action = action;
    if (paneId) node.dataset.paneId = paneId;
    return node;
  }

  function envelope(type, data = {}, paneId = null, generation = null) {
    return { version: 1, id: crypto.randomUUID(), type, paneId, generation, data };
  }

  function post(type, data = {}, paneId = null, generation = null) {
    if (!host) throw new Error("The desktop bridge is unavailable. Open PromptTerminal.App.exe, not this HTML file.");
    host.postMessage(envelope(type, data, paneId, generation));
  }

  function command(type, data = {}, paneId = null, generation = null) {
    if (!host) return Promise.reject(new Error("The desktop bridge is unavailable."));
    const message = envelope(type, data, paneId, generation);
    const result = new Promise((resolve, reject) => {
      requests.set(message.id, { resolve, reject });
      host.postMessage(message);
    });
    if (workspaceMutations.has(type)) {
      pendingWorkspaceMutation = result;
      const clear = () => { if (pendingWorkspaceMutation === result) pendingWorkspaceMutation = null; };
      result.then(clear, clear);
    }
    return result;
  }

  function notice(message, error = false) {
    const node = element("div", `notice${error ? " error" : ""}`);
    node.setAttribute("role", error ? "alert" : "status");
    node.append(element("span", "", message));
    const close = element("button", "", "x");
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", () => node.remove());
    node.append(close);
    $("#notices").append(node);
    if (!error) setTimeout(() => node.remove(), 10000);
  }

  const safely = action => Promise.resolve().then(action).catch(error => notice(error.message, true));
  const activeTab = () => state?.document.workspace.tabs.find(tab => tab.id === state.document.workspace.activeTabId);
  const activePane = () => activeTab()?.panes.find(pane => pane.id === activeTab().activePaneId);
  const ownerTab = id => state.document.workspace.tabs.find(tab => tab.panes.some(pane => pane.id === id));
  const paneDefinition = id => ownerTab(id)?.panes.find(pane => pane.id === id);
  const runtimeFor = id => runtimes.get(id) || { generation: 0, state: "notStarted" };
  const clone = value => structuredClone(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function focusActive() {
    const pane = activePane();
    if (pane && !$("#app-dialog").open) panes.get(pane.id)?.terminal.focus();
  }

  function receive(message) {
    switch (message.type) {
      case "result": {
        const request = requests.get(message.id);
        if (request) {
          requests.delete(message.id);
          if (message.ok) request.resolve(!message.cancelled);
          else request.reject(new Error(message.error));
        } else if (!message.ok) notice(message.error, true);
        break;
      }
      case "state":
        renderState(message);
        break;
      case "output":
        receiveOutput(message);
        break;
      case "clear":
        panes.get(message.paneId)?.terminal.clear();
        break;
      case "paste": {
        const pane = panes.get(message.paneId);
        if (pane?.generation === message.generation && !paneDefinition(message.paneId)?.readOnly) {
          pane.terminal.paste(message.text);
          pane.terminal.focus();
        }
        break;
      }
      case "unread":
        if (state && !state.unreadTabs.includes(message.tabId)) state.unreadTabs.push(message.tabId);
        renderTabs();
        break;
      case "metrics":
        for (const sample of message.items) {
          const pane = panes.get(sample.paneId);
          if (pane) pane.metrics.textContent = `${sample.cpu.toFixed(1)}% | ${(sample.memory / 1048576).toFixed(0)} MiB`;
        }
        break;
      case "saveStatus":
        $("#save-status").textContent = message.text;
        break;
      case "notice":
        notice(message.message, message.error);
        break;
      default:
        throw new Error(`Unsupported desktop message: ${message.type}`);
    }
  }

  function receiveOutput(message) {
    const pane = panes.get(message.paneId);
    if (!pane || message.generation !== pane.generation) return;
    if (message.sequence <= pane.lastSequence) {
      post("outputAck", { sequence: message.sequence }, pane.id, pane.generation);
      return;
    }
    if (message.sequence === pane.pendingSequence) return;
    if (pane.pendingSequence || (pane.lastSequence && message.sequence !== pane.lastSequence + 1)) {
      post("rendererError", { text: "Terminal output arrived out of order. Output is paused; no batch was discarded." });
      return;
    }
    pane.pendingSequence = message.sequence;
    const generation = pane.generation;
    pane.terminal.write(message.text, () => {
      if (panes.get(pane.id) !== pane || pane.generation !== generation) return;
      pane.lastSequence = message.sequence;
      pane.pendingSequence = 0;
      post("outputAck", { sequence: message.sequence }, pane.id, generation);
    });
  }

  function renderState(message) {
    const focused = document.activeElement?.closest(".pane");
    lastTerminalFocus = !!focused && document.activeElement?.classList.contains("xterm-helper-textarea");
    state = message;
    runtimes.clear();
    for (const runtime of message.runtimes) runtimes.set(runtime.paneId, runtime);
    document.documentElement.dataset.theme = message.resolvedTheme;
    $("#save-status").textContent = message.saveStatus;
    $("#power-status").textContent = message.keepAwakeEnabled ? "Keep-awake on" : "Sleep allowed";
    $("#power-status").title = "Keep-awake prevents automatic idle sleep/hibernation only while this app is open. The display can still turn off.";
    const nextSettingsKey = JSON.stringify([message.document.settings, message.resolvedTheme]);
    const settingsChanged = nextSettingsKey !== settingsKey;
    settingsKey = nextSettingsKey;
    renderTabs();
    const allPaneIds = new Set(message.document.workspace.tabs.flatMap(tab => tab.panes.map(pane => pane.id)));
    for (const [id, pane] of panes) {
      if (allPaneIds.has(id)) continue;
      clearTimeout(pane.resizeTimer);
      pane.terminal.dispose();
      pane.article.remove();
      panes.delete(id);
    }
    for (const tab of message.document.workspace.tabs) {
      const view = ensureTab(tab);
      const active = tab.id === message.document.workspace.activeTabId;
      view.section.classList.toggle("is-inactive", !active);
      view.section.setAttribute("aria-hidden", String(!active));
      view.section.inert = !active;
      view.empty.hidden = tab.panes.length > 0;
      for (const definition of tab.panes) {
        let pane = panes.get(definition.id);
        if (pane && pane.generation !== runtimeFor(definition.id).generation) {
          clearTimeout(pane.resizeTimer);
          pane.terminal.dispose();
          pane.article.remove();
          panes.delete(definition.id);
          pane = null;
        }
        pane ||= createPane(definition, view);
        if (pane.article.parentElement !== view.canvas) view.canvas.append(pane.article);
        updatePane(pane, definition, tab);
        if (settingsChanged) applyTerminalSettings(pane);
      }
    }
    for (const [id, tab] of tabs) {
      if (message.document.workspace.tabs.some(item => item.id === id)) continue;
      tab.section.remove();
      tabs.delete(id);
    }
    if (!drag) renderLayouts();
    if (lastTerminalFocus) focusActive();
    refreshSchedules?.();
  }

  function renderTabs() {
    if (!state) return;
    const parent = $("#tabs");
    for (const tab of state.document.workspace.tabs) {
      let wrapper = Array.from(parent.children).find(node => node.dataset.tabId === tab.id);
      if (!wrapper) {
        wrapper = element("div", "tab-wrapper");
        wrapper.dataset.tabId = tab.id;
        wrapper.draggable = true;
        const select = button("", "selectTab");
        select.className = "tab";
        select.setAttribute("role", "tab");
        select.dataset.tabId = tab.id;
        select.append(element("span", "tab-name"), element("span", "unread-dot", "New output"));
        const close = button("x", "closeTab", null, "tab-close");
        close.dataset.tabId = tab.id;
        wrapper.append(select, close);
        wrapper.addEventListener("dragstart", event => event.dataTransfer.setData("text/plain", tab.id));
        wrapper.addEventListener("dragover", event => event.preventDefault());
        wrapper.addEventListener("drop", event => {
          event.preventDefault();
          const tabId = event.dataTransfer.getData("text/plain");
          if (state.document.workspace.tabs.some(item => item.id === tabId))
            safely(() => command("reorderTab", { tabId, index: state.document.workspace.tabs.findIndex(item => item.id === tab.id) }));
        });
        wrapper.addEventListener("contextmenu", event => {
          event.preventDefault();
          openTabOptions(tab.id);
        });
      }
      const selected = tab.id === state.document.workspace.activeTabId;
      wrapper.classList.toggle("active", selected);
      wrapper.style.setProperty("--tab-accent", tab.accentColor);
      $(".tab-name", wrapper).textContent = tab.name;
      $(".unread-dot", wrapper).hidden = !state.unreadTabs.includes(tab.id);
      $(".tab", wrapper).setAttribute("aria-selected", String(selected));
      $(".tab", wrapper).setAttribute("aria-controls", `workspace-${tab.id}`);
      $(".tab", wrapper).tabIndex = selected ? 0 : -1;
      $(".tab-close", wrapper).setAttribute("aria-label", `Close tab ${tab.name}`);
      const index = state.document.workspace.tabs.indexOf(tab);
      if (parent.children[index] !== wrapper) parent.insertBefore(wrapper, parent.children[index] || null);
    }
    for (const node of Array.from(parent.children))
      if (!state.document.workspace.tabs.some(tab => tab.id === node.dataset.tabId)) node.remove();
  }

  function ensureTab(tab) {
    if (tabs.has(tab.id)) return tabs.get(tab.id);
    const section = element("section", "workspace");
    section.id = `workspace-${tab.id}`;
    section.setAttribute("role", "tabpanel");
    const canvas = element("div", "canvas");
    const empty = element("div", "empty-workspace");
    empty.append(element("h2", "", "Room for your next agent"), element("p", "", "Add a pane, configure its shell, then explicitly start it."), button("+ Add a pane", "newPane"));
    const preview = element("div", "dock-preview");
    preview.hidden = true;
    canvas.append(empty, preview);
    section.append(canvas);
    $("#workspaces").append(section);
    const view = { section, canvas, empty, preview, splitters: new Map() };
    tabs.set(tab.id, view);
    return view;
  }

  function createPane(definition, view) {
    const article = element("article", "pane");
    article.dataset.paneId = definition.id;
    article.setAttribute("role", "region");
    const header = element("header", "pane-header");
    const title = button(definition.name, "editPane", definition.id, "pane-name");
    const start = button(">", "startPane", definition.id, "icon-button");
    const maximize = button("[]", "maximize", definition.id, "icon-button");
    const float = button("~", "toggleFloat", definition.id, "icon-button");
    const menu = element("details", "menu");
    const summary = element("summary", "", "...");
    summary.setAttribute("aria-label", "Pane actions");
    const menuItems = element("div", "menu-items");
    for (const [text, action] of [
      ["Edit launch configuration...", "editPane"], ["Duplicate as new pane", "duplicatePane"],
      ["Interrupt (Ctrl+C)", "interrupt"], ["Restart with new process...", "restartPane"], ["Run configured resume command...", "resumePane"],
      ["Review and arm recurring task...", "armSchedule"], ["Disarm recurring task", "cancelSchedule"],
      ["Stop process tree...", "stopPane"], ["Clear view (not agent memory)", "clearView"],
      ["Copy selection", "copy"], ["Paste...", "paste"], ["Search terminal", "search"],
      ["Dock with placement preview...", "dockPane"], ["Move to another tab...", "movePane"],
      ["Toggle read-only", "readOnly"], ["Export transcript...", "transcript"]
    ]) menuItems.append(button(text, action, definition.id));
    menu.append(summary, menuItems);
    const close = button("x", "closePane", definition.id, "icon-button");
    header.append(title, start, maximize, float, menu, close);
    const body = element("div", "pane-body");
    const terminalView = element("div", "terminal-view");
    const cover = element("div", "empty-cover");
    body.append(terminalView, cover);
    const footer = element("div", "pane-footer");
    const status = element("span", "pane-state");
    const path = element("span", "pane-path");
    const signal = element("span", "pane-signal");
    const schedule = element("span", "pane-schedule");
    const metrics = element("span", "pane-metrics");
    metrics.title = "Shell host CPU and memory only; descendant agents are not attributed.";
    footer.append(status, path, signal, schedule, metrics);
    const grip = element("div", "resize-grip");
    grip.title = "Resize floating panel; use pane configuration for keyboard-accessible bounds";
    article.append(header, body, footer, grip);
    view.canvas.append(article);
    const terminal = new Terminal({
      cursorBlink: true, convertEol: false,
      allowProposedApi: false,
      linkHandler: { activate: (event, url) => { event.preventDefault(); safely(() => command("openLink", { url })); } }
    });
    const fit = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    const serialize = new SerializeAddon.SerializeAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(serialize);
    terminal.loadAddon(new WebLinksAddon.WebLinksAddon((event, url) => {
      event.preventDefault();
      safely(() => command("openLink", { url }));
    }));
    terminal.parser.registerOscHandler(52, () => true);
    terminal.open(terminalView);
    const pane = {
      id: definition.id, article, header, title, start, maximize, float, close, cover, status, path, signal, schedule, metrics,
      terminal, fit, search, serialize, generation: 0, lastSequence: 0, pendingSequence: 0,
      lastSize: "", resizeTimer: null
    };
    panes.set(pane.id, pane);
    applyTerminalSettings(pane);
    terminal.onData(text => {
      if (runtimeFor(pane.id).state === "running" && !paneDefinition(pane.id)?.readOnly)
        post("input", { text }, pane.id, pane.generation);
    });
    terminal.textarea.setAttribute("aria-label", `${definition.name} terminal`);
    terminal.textarea.addEventListener("focus", () => activatePane(pane.id));
    article.addEventListener("pointerdown", () => activatePane(pane.id));
    header.addEventListener("pointerdown", event => {
      if (!event.target.closest("button, summary") && ownerTab(pane.id)?.floating.some(item => item.paneId === pane.id))
        beginFloatingDrag(pane, event, "move");
    });
    grip.addEventListener("pointerdown", event => beginFloatingDrag(pane, event, "resize"));
    return pane;
  }

  function activatePane(id) {
    if (!state || $("#app-dialog").open) return;
    const tab = ownerTab(id);
    const floating = tab?.floating.find(item => item.paneId === id);
    if (tab && (tab.activePaneId !== id || tab.id !== state.document.workspace.activeTabId ||
        (floating && floating.z < Math.max(...tab.floating.map(item => item.z)) && !drag)))
      safely(() => command("focusPane", { paneId: id }));
  }

  function updatePane(pane, definition, tab) {
    const runtime = runtimeFor(pane.id);
    if (runtime.generation !== pane.generation) {
      clearTimeout(pane.resizeTimer);
      pane.generation = runtime.generation;
      pane.lastSequence = 0;
      pane.pendingSequence = 0;
      pane.lastSize = "";
      pane.terminal.reset();
    }
    pane.article.dataset.generation = String(pane.generation);
    pane.article.dataset.state = runtime.state;
    pane.article.setAttribute("aria-label", `${definition.name} pane`);
    pane.article.style.setProperty("--pane-accent", definition.profile.accentColor);
    pane.article.classList.toggle("active", tab.activePaneId === pane.id);
    pane.article.classList.toggle("floating", tab.floating.some(item => item.paneId === pane.id));
    pane.title.textContent = definition.name;
    pane.title.title = `${definition.name} - edit future launch settings`;
    pane.terminal.textarea.setAttribute("aria-label", `${definition.name} terminal`);
    pane.terminal.options.disableStdin = definition.readOnly || runtime.state !== "running";
    const names = { notStarted: "Not started", queued: "Queued", starting: "Starting", running: "Running", stopping: "Stopping", exited: "Exited", failed: "Failed" };
    pane.status.textContent = `${names[runtime.state] || runtime.state}${runtime.processId ? ` PID ${runtime.processId}` : ""}${runtime.exitCode !== null && runtime.exitCode !== undefined ? ` (${runtime.exitCode})` : ""}${definition.readOnly ? " | Read-only" : ""}`;
    pane.status.dataset.state = runtime.state;
    if (runtime.state !== "running") pane.metrics.textContent = "";
    pane.path.textContent = `${runtime.directoryIsLive ? "Current" : "Initial"}: ${runtime.directory || definition.profile.workingDirectory}${runtime.branch ? ` | ${runtime.branch}` : ""}`;
    pane.path.title = `${pane.path.textContent}${runtime.branch ? `\nBranch: ${runtime.branch}` : ""}\nShell: ${runtime.executable || definition.profile.executable}`;
    pane.signal.textContent = runtime.signal ? `Integration: ${runtime.signal}` : "";
    pane.signal.title = runtime.signalMessage || "";
    const scheduled = state.schedules?.find(item => item.paneId === pane.id);
    pane.schedule.textContent = scheduled ? `Next: ${new Date(scheduled.nextRun).toLocaleString()}` :
      definition.plan.recurrence ? "Schedule not armed" : "";
    pane.schedule.title = scheduled ? `${scheduleSummary(scheduled.recurrence)}\n${scheduled.message}\nReviewed settings remain in effect until disarmed and re-armed.` : "";
    for (const control of pane.article.querySelectorAll('[data-action="armSchedule"]'))
      control.hidden = !definition.plan.recurrence || !!scheduled;
    for (const control of pane.article.querySelectorAll('[data-action="cancelSchedule"]')) control.hidden = !scheduled;
    pane.start.hidden = ["queued", "starting", "running", "stopping"].includes(runtime.state);
    pane.start.setAttribute("aria-label", `Start pane ${definition.name}`);
    pane.start.title = "Review and start this pane";
    pane.maximize.setAttribute("aria-label", `Maximize or restore ${definition.name}`);
    pane.float.setAttribute("aria-label", `Float or dock ${definition.name}`);
    pane.close.setAttribute("aria-label", `Close pane ${definition.name}`);
    pane.cover.hidden = ["running", "exited", "stopping"].includes(runtime.state);
    let text = runtime.error || ({
      notStarted: "Configure this shell and review its startup command before starting.",
      queued: "Waiting for the reviewed launch plan. Shell exit or silence is not completion.",
      starting: "Creating an independent PowerShell pseudoconsole..."
    }[runtime.state] || "");
    if (runtime.state === "queued") {
      if (runtime.notBefore) text += `\nNot before: ${new Date(runtime.notBefore).toLocaleString()}`;
      if (runtime.afterPaneId) text += `\nRequires completed signal: ${paneDefinition(runtime.afterPaneId)?.name || runtime.afterPaneId}, launch ${runtime.dependencyGeneration}`;
    }
    const coverKey = JSON.stringify([runtime.state, definition.name, text, definition.plan.recurrence, scheduled?.nextRun]);
    if (pane.cover.dataset.key !== coverKey) {
      pane.cover.dataset.key = coverKey;
      pane.cover.replaceChildren();
      pane.cover.append(element("strong", "", names[runtime.state] || runtime.state));
      pane.cover.append(element("p", runtime.error ? "failed-text" : "", text));
      if (runtime.state === "notStarted" || runtime.state === "failed")
        pane.cover.append(button("Review and start", "startPane", pane.id), button("Edit configuration", "editPane", pane.id));
      if (runtime.state === "queued") pane.cover.append(button("Cancel queued launch", "stopPane", pane.id));
      if (definition.plan.recurrence && !scheduled)
        pane.cover.append(button("Review and arm schedule", "armSchedule", pane.id));
    }
  }

  function applyTerminalSettings(pane) {
    const settings = state.document.settings;
    const dark = state.resolvedTheme === "dark";
    pane.terminal.options.fontFamily = settings.fontFamily;
    pane.terminal.options.fontSize = settings.fontSize;
    pane.terminal.options.scrollback = settings.scrollback;
    pane.terminal.options.screenReaderMode = !!settings.screenReaderMode;
    pane.terminal.options.theme = dark ? {
      background: "#0b1020", foreground: "#e8edf7", cursor: "#afc5ff", cursorAccent: "#0b1020",
      selectionBackground: "#33486b", black: "#263149", red: "#f38ba8", green: "#a6da95", yellow: "#eed49f",
      blue: "#8aadf4", magenta: "#c6a0f6", cyan: "#8bd5ca", white: "#e8edf7",
      brightBlack: "#8797b3", brightRed: "#ffb4b4", brightGreen: "#b9edaa", brightYellow: "#ffe6b4",
      brightBlue: "#b7cdff", brightMagenta: "#ddc2ff", brightCyan: "#b1f1e8", brightWhite: "#ffffff"
    } : {
      background: "#ffffff", foreground: "#172236", cursor: "#344cb7", cursorAccent: "#ffffff",
      selectionBackground: "#ccdcf5", black: "#172236", red: "#a52134", green: "#24633b", yellow: "#765000",
      blue: "#294fba", magenta: "#8439a5", cyan: "#126577", white: "#69768a",
      brightBlack: "#526176", brightRed: "#b62d3e", brightGreen: "#287340", brightYellow: "#836000",
      brightBlue: "#345dcc", brightMagenta: "#9545b5", brightCyan: "#087485", brightWhite: "#8894a8"
    };
  }

  function minimum(node) {
    if (!node) return { width: 320, height: 210 };
    if (node.paneId) return { width: 320, height: 210 };
    const first = minimum(node.first);
    const second = minimum(node.second);
    return node.axis === "horizontal"
      ? { width: first.width + second.width + gap, height: Math.max(first.height, second.height) }
      : { width: Math.max(first.width, second.width), height: first.height + second.height + gap };
  }

  function position(node, rect) {
    Object.assign(node.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  function renderLayouts() {
    if (!state) return;
    paneRects.clear();
    splitterRects.clear();
    const viewport = $("#workspaces");
    for (const tab of state.document.workspace.tabs) {
      const view = tabs.get(tab.id);
      const size = minimum(tab.root);
      const width = Math.max(320, viewport.clientWidth - inset * 2);
      const height = Math.max(210, viewport.clientHeight - inset * 2);
      const rootRect = { x: inset, y: inset, width: Math.max(width, size.width), height: Math.max(height, size.height) };
      const usedSplitters = new Set();
      const maximized = state.maximized[tab.id];
      if (tab.root) layoutNode(tab.root, rootRect, tab, view, usedSplitters);
      for (const floating of tab.floating) {
        const pane = panes.get(floating.paneId);
        const bounds = {
          x: clamp(floating.x, 0, Math.max(0, width - 100)),
          y: clamp(floating.y, 0, Math.max(0, height - 35)),
          width: floating.width, height: floating.height
        };
        position(pane.article, bounds);
        pane.article.style.zIndex = String(100 + floating.z);
        paneRects.set(pane.id, bounds);
      }
      for (const definition of tab.panes) {
        const pane = panes.get(definition.id);
        const masked = !!maximized && maximized !== pane.id;
        pane.article.classList.toggle("is-masked", masked);
        pane.article.inert = masked;
        if (maximized === pane.id) {
          position(pane.article, { x: inset, y: inset, width, height });
          pane.article.style.zIndex = "10000";
        }
      }
      for (const [id, splitter] of view.splitters) {
        if (!usedSplitters.has(id)) { splitter.remove(); view.splitters.delete(id); }
        else splitter.hidden = !!maximized;
      }
      const maxX = Math.max(rootRect.width + inset * 2, ...tab.floating.map(item => (paneRects.get(item.paneId)?.x || 0) + item.width + inset));
      const maxY = Math.max(rootRect.height + inset * 2, ...tab.floating.map(item => (paneRects.get(item.paneId)?.y || 0) + item.height + inset));
      view.canvas.style.width = `${maximized ? width + inset * 2 : maxX}px`;
      view.canvas.style.height = `${maximized ? height + inset * 2 : maxY}px`;
    }
    scheduleFits();
  }

  function layoutNode(node, rect, tab, view, used) {
    if (node.paneId) {
      const pane = panes.get(node.paneId);
      position(pane.article, rect);
      pane.article.style.zIndex = "2";
      paneRects.set(node.paneId, rect);
      return;
    }
    const horizontal = node.axis === "horizontal";
    const span = (horizontal ? rect.width : rect.height) - gap;
    const ratio = drag?.kind === "split" && drag.nodeId === node.id ? drag.ratio : node.ratio;
    const firstMin = minimum(node.first);
    const secondMin = minimum(node.second);
    const firstSize = clamp(span * ratio, horizontal ? firstMin.width : firstMin.height, span - (horizontal ? secondMin.width : secondMin.height));
    const first = { ...rect };
    const second = { ...rect };
    const splitterRect = { ...rect };
    if (horizontal) {
      first.width = firstSize;
      second.x += firstSize + gap;
      second.width = span - firstSize;
      splitterRect.x += firstSize;
      splitterRect.width = gap;
    } else {
      first.height = firstSize;
      second.y += firstSize + gap;
      second.height = span - firstSize;
      splitterRect.y += firstSize;
      splitterRect.height = gap;
    }
    let splitter = view.splitters.get(node.id);
    if (!splitter) {
      splitter = element("div", `splitter ${node.axis}`);
      splitter.tabIndex = 0;
      splitter.setAttribute("role", "separator");
      splitter.setAttribute("aria-label", "Resize tiled panes");
      splitter.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
      splitter.setAttribute("aria-valuemin", "10");
      splitter.setAttribute("aria-valuemax", "90");
      splitter.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        const current = splitterRects.get(node.id);
        drag = { kind: "split", nodeId: node.id, tabId: tab.id, start: horizontal ? event.clientX : event.clientY,
          span: current.span, initial: current.ratio, ratio: current.ratio, horizontal };
      });
      splitter.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const current = splitterRects.get(node.id);
        const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
        safely(() => command("resizeSplit", { tabId: tab.id, nodeId: node.id, ratio: clamp(current.ratio + direction * .05, .1, .9) }));
      });
      view.canvas.append(splitter);
      view.splitters.set(node.id, splitter);
    }
    splitter.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    position(splitter, splitterRect);
    splitterRects.set(node.id, { rect, ratio, span });
    used.add(node.id);
    layoutNode(node.first, first, tab, view, used);
    layoutNode(node.second, second, tab, view, used);
  }

  function scheduleFits() {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      for (const pane of panes.values()) {
        const dimensions = pane.fit.proposeDimensions();
        if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) continue;
        const columns = clamp(dimensions.cols, 2, 1000);
        const rows = clamp(dimensions.rows, 1, 1000);
        if (pane.terminal.cols !== columns || pane.terminal.rows !== rows) pane.terminal.resize(columns, rows);
        const size = `${pane.generation}:${columns}x${rows}`;
        if (runtimeFor(pane.id).state !== "running" || size === pane.lastSize) continue;
        clearTimeout(pane.resizeTimer);
        pane.resizeTimer = setTimeout(() => {
          if (runtimeFor(pane.id).state !== "running") return;
          pane.lastSize = size;
          post("resize", { columns, rows }, pane.id, pane.generation);
        }, 35);
      }
    });
  }

  function beginFloatingDrag(pane, event, kind) {
    if (event.button !== 0 || state.maximized[ownerTab(pane.id).id]) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = paneRects.get(pane.id);
    drag = { kind, paneId: pane.id, tabId: ownerTab(pane.id).id, startX: event.clientX, startY: event.clientY,
      initial: { ...bounds }, bounds: { ...bounds }, docking: null };
  }

  function dockingTarget(event, movingId) {
    const tab = activeTab();
    for (const definition of tab.panes) {
      if (definition.id === movingId || tab.floating.some(item => item.paneId === definition.id)) continue;
      const rect = panes.get(definition.id).article.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue;
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      const distances = [x, 1 - x, y, 1 - y];
      return { targetPaneId: definition.id, edge: ["left", "right", "above", "below"][distances.indexOf(Math.min(...distances))] };
    }
    return null;
  }

  function showDockPreview(tabId, targetPaneId, edge) {
    const view = tabs.get(tabId);
    const rect = targetPaneId ? paneRects.get(targetPaneId) : { x: inset, y: inset, width: view.section.clientWidth - inset * 2, height: view.section.clientHeight - inset * 2 };
    if (!rect) return;
    const preview = { ...rect };
    if (edge === "left" || edge === "right") {
      preview.width /= 2;
      if (edge === "right") preview.x += preview.width;
    } else {
      preview.height /= 2;
      if (edge === "below") preview.y += preview.height;
    }
    position(view.preview, preview);
    view.preview.textContent = `Dock ${edge}`;
    view.preview.hidden = false;
  }

  function hideDockPreviews() { for (const tab of tabs.values()) tab.preview.hidden = true; }
  const dockOptions = (paneId, targetPaneId, edge) => ({
    paneId, targetPaneId, axis: ["left", "right"].includes(edge) ? "horizontal" : "vertical", before: ["left", "above"].includes(edge)
  });

  document.addEventListener("pointermove", event => {
    if (!drag) return;
    if (drag.kind === "split") {
      drag.ratio = clamp(drag.initial + ((drag.horizontal ? event.clientX : event.clientY) - drag.start) / drag.span, .1, .9);
      renderLayouts();
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    drag.bounds = drag.kind === "move"
      ? { ...drag.initial, x: Math.max(0, drag.initial.x + deltaX), y: Math.max(0, drag.initial.y + deltaY) }
      : { ...drag.initial, width: clamp(drag.initial.width + deltaX, 280, 100000), height: clamp(drag.initial.height + deltaY, 180, 100000) };
    position(panes.get(drag.paneId).article, drag.bounds);
    drag.docking = event.altKey && drag.kind === "move" ? dockingTarget(event, drag.paneId) : null;
    hideDockPreviews();
    if (drag.docking) showDockPreview(drag.tabId, drag.docking.targetPaneId, drag.docking.edge);
    scheduleFits();
  });

  function finishDrag(cancelled) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    hideDockPreviews();
    if (cancelled) { renderLayouts(); return; }
    safely(async () => {
      try {
        if (finished.kind === "split")
          await command("resizeSplit", { tabId: finished.tabId, nodeId: finished.nodeId, ratio: finished.ratio });
        else if (finished.docking)
          await command("dockPane", dockOptions(finished.paneId, finished.docking.targetPaneId, finished.docking.edge));
        else
          await command("floatingBounds", { paneId: finished.paneId, ...finished.bounds });
      } catch (error) { renderLayouts(); throw error; }
    });
  }
  document.addEventListener("pointerup", () => finishDrag(false));
  document.addEventListener("pointercancel", () => finishDrag(true));

  function field(parent, name, label, type, value, options = {}) {
    const wrapper = element("div", `form-field${options.full ? " full" : ""}`);
    const caption = element("label", "", label);
    caption.htmlFor = `field-${crypto.randomUUID()}`;
    wrapper.append(caption);
    let input;
    if (type === "select") {
      input = element("select");
      for (const [id, text] of options.items) {
        const option = element("option", "", text);
        option.value = id;
        input.append(option);
      }
    } else if (type === "textarea") {
      input = element("textarea");
      input.rows = options.rows || 4;
      input.spellcheck = false;
    } else {
      input = element("input");
      input.type = type;
    }
    input.name = name;
    input.id = caption.htmlFor;
    input.value = value ?? "";
    if (options.required) input.required = true;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    if (options.step !== undefined) input.step = String(options.step);
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.placeholder) input.placeholder = options.placeholder;
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function checkbox(parent, name, label, checked) {
    const wrapper = element("label", "checkbox-field");
    const input = element("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = !!checked;
    wrapper.append(input, element("span", "", label));
    parent.append(wrapper);
    return input;
  }

  function showDialog(title, intro, submitLabel, build, onSubmit, cleanup) {
    const dialog = $("#app-dialog");
    if (dialog.open) dialog.close();
    dialogCleanup?.();
    dialogCleanup = cleanup;
    $("#dialog-title").textContent = title;
    $("#dialog-intro").textContent = intro;
    $("#dialog-error").hidden = true;
    $("#dialog-submit").textContent = submitLabel || "Done";
    $("#dialog-submit").hidden = !onSubmit;
    $("#dialog-submit").disabled = false;
    $("#dialog-body").replaceChildren();
    build($("#dialog-body"));
    dialogSubmit = onSubmit;
    dialog.showModal();
  }

  function closeDialog() {
    $("#app-dialog").close();
    dialogCleanup?.();
    dialogCleanup = null;
    focusActive();
  }

  $("#dialog-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!dialogSubmit) return;
    const submit = $("#dialog-submit");
    submit.disabled = true;
    $("#dialog-error").hidden = true;
    try {
      const result = await dialogSubmit(new FormData(event.currentTarget), event.currentTarget);
      if (result !== false) closeDialog();
    } catch (error) {
      $("#dialog-error").textContent = error.message;
      $("#dialog-error").hidden = false;
    } finally { submit.disabled = false; }
  });
  $("#app-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  document.addEventListener("click", event => { if (event.target.closest("[data-dialog-close]")) closeDialog(); });

  function openPaneEditor(id = null, selectedProfile = null, profileOnly = false) {
    const definition = id ? paneDefinition(id) : null;
    const profile = clone(selectedProfile || definition?.profile || state.document.profiles[0] || {
      id: crypto.randomUUID(), name: "PowerShell", executable: "pwsh.exe", workingDirectory: "", startupScript: "", resumeScript: "",
      environment: {}, loadUserProfile: true, keepShellOpen: true, enableIntegration: true, accentColor: "#7c8aff"
    });
    const tab = activeTab();
    const inputs = {};
    showDialog(profileOnly ? "Launch profile" : definition ? "Edit pane configuration" : "Add terminal pane",
      "Launch edits do not change running sessions or armed schedules; disarm and review again to apply changes. Read-only applies immediately. Scripts and environment overrides are plain text: do not enter secrets.",
      profileOnly ? "Save profile" : definition ? "Save configuration" : "Add unstarted pane", body => {
        const grid = element("div", "form-grid");
        body.append(grid);
        if (!profileOnly) {
          inputs.savedProfile = field(grid, "savedProfile", "Copy a saved launch profile", "select", "", {
            full: true, items: [["", "Custom configuration"], ...state.document.profiles.map(item => [item.id, item.name])]
          });
          inputs.paneName = field(grid, "paneName", "Pane name", "text", definition?.name || profile.name, { required: true, maxLength: 100 });
        }
        inputs.name = field(grid, "name", "Profile name", "text", profile.name, { required: true, maxLength: 100 });
        inputs.executable = field(grid, "executable", "PowerShell executable", "text", profile.executable, { full: true, required: true });
        inputs.workingDirectory = field(grid, "workingDirectory", "Initial working directory", "text", profile.workingDirectory, { full: true, required: true });
        inputs.startupScript = field(grid, "startupScript", "Startup command or multiline PowerShell script", "textarea", profile.startupScript, { full: true, rows: 5 });
        inputs.resumeScript = field(grid, "resumeScript", "Optional agent-specific resume command (explicit action only)", "textarea", profile.resumeScript, { full: true, rows: 2 });
        inputs.environment = field(grid, "environment", "Non-secret environment overrides (JSON string values)", "textarea", JSON.stringify(profile.environment, null, 2), { full: true, rows: 3 });
        inputs.accentColor = field(grid, "accentColor", "Pane accent color", "color", profile.accentColor);
        inputs.loadUserProfile = checkbox(grid, "loadUserProfile", "Load the user's PowerShell profile", profile.loadUserProfile);
        inputs.keepShellOpen = checkbox(grid, "keepShellOpen", "Keep shell open after startup script", profile.keepShellOpen);
        inputs.enableIntegration = checkbox(grid, "enableIntegration", "Enable explicit shell integration signals", profile.enableIntegration);
        if (!profileOnly) {
          inputs.readOnly = checkbox(grid, "readOnly", "Read-only monitoring (blocks input and interrupt)", definition?.readOnly);
          if (!definition) inputs.floating = checkbox(grid, "floating", "Create as floating panel", tab.floating.length > 0);
          inputs.notBefore = field(grid, "notBefore", "Optional earliest launch time", "datetime-local",
            definition?.plan.notBefore ? localDateTime(definition.plan.notBefore) : "");
          inputs.afterPaneId = field(grid, "afterPaneId", "Wait for explicit completed signal from", "select", definition?.plan.afterPaneId || "", {
            items: [["", "No dependency"], ...state.document.workspace.tabs.flatMap(item =>
              item.panes.filter(pane => pane.id !== id).map(pane => [pane.id, `${item.name} / ${pane.name}`]))]
          });
          const recurrence = definition?.plan.recurrence;
          inputs.frequency = field(grid, "frequency", "Recurring task", "select", recurrence?.frequency || "", {
            items: [["", "None (start once)"], ["daily", "Daily"], ["weekdays", "Weekdays (Mon-Fri)"], ["weekly", "Weekly"]]
          });
          inputs.scheduleTime = field(grid, "scheduleTime", "Recurring local time", "time", recurrence?.time || "09:00", { step: 1 });
          inputs.scheduleDay = field(grid, "scheduleDay", "Weekly day", "select", recurrence?.day || "monday", {
            items: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
              .map(day => [day, day[0].toUpperCase() + day.slice(1)])
          });
          const updateRecurrence = () => {
            inputs.scheduleTime.disabled = !inputs.frequency.value;
            inputs.scheduleTime.required = !!inputs.frequency.value;
            inputs.scheduleDay.disabled = inputs.frequency.value !== "weekly";
          };
          inputs.frequency.addEventListener("change", updateRecurrence);
          updateRecurrence();
          body.append(element("p", "form-note", "Recurring tasks must be explicitly reviewed and armed in Schedules or pane actions each time the app opens. They run the startup script in a fresh shell that closes when the script finishes, regardless of Keep shell open. Busy/queued panes and missed occurrences are skipped; manual starts remain separate."));
          inputs.saveProfile = checkbox(grid, "saveProfile", "Also save a reusable launch profile", false);
        }
        inputs.savedProfile?.addEventListener("change", () => {
          const saved = state.document.profiles.find(item => item.id === inputs.savedProfile.value);
          if (!saved) return;
          for (const name of ["name", "executable", "workingDirectory", "startupScript", "resumeScript", "accentColor"]) inputs[name].value = saved[name];
          for (const name of ["loadUserProfile", "keepShellOpen", "enableIntegration"]) inputs[name].checked = saved[name];
          inputs.environment.value = JSON.stringify(saved.environment, null, 2);
          if (!definition) inputs.paneName.value = saved.name;
        });
        if (definition && tab.floating.some(item => item.paneId === id)) {
          const bounds = tab.floating.find(item => item.paneId === id);
          body.append(element("p", "form-note", "Keyboard-accessible floating position and size (logical pixels):"));
          const geometry = element("div", "form-grid");
          body.append(geometry);
          for (const [name, label, min] of [["x", "Left", 0], ["y", "Top", 0], ["width", "Width", 280], ["height", "Height", 180]])
            inputs[name] = field(geometry, name, label, "number", bounds[name], { required: true, min, max: 100000 });
        }
      }, async () => {
        let environment;
        try { environment = JSON.parse(inputs.environment.value); }
        catch { throw new Error("Environment overrides must be a JSON object with string values."); }
        if (!environment || Array.isArray(environment) || typeof environment !== "object" || Object.values(environment).some(value => typeof value !== "string"))
          throw new Error("Environment overrides must be a JSON object with string values.");
        const edited = {
          ...profile, id: profileOnly ? profile.id : crypto.randomUUID(), environment,
          name: inputs.name.value.trim(), executable: inputs.executable.value.trim(), workingDirectory: inputs.workingDirectory.value.trim(),
          startupScript: inputs.startupScript.value, resumeScript: inputs.resumeScript.value, accentColor: inputs.accentColor.value,
          loadUserProfile: inputs.loadUserProfile.checked, keepShellOpen: inputs.keepShellOpen.checked, enableIntegration: inputs.enableIntegration.checked
        };
        if (profileOnly) return command("saveProfile", edited);
        const pane = {
          id: id || crypto.randomUUID(), name: inputs.paneName.value.trim(), profile: edited, readOnly: inputs.readOnly.checked,
          plan: {
            notBefore: inputs.notBefore.value ? new Date(inputs.notBefore.value).toISOString() : null,
            afterPaneId: inputs.afterPaneId.value || null,
            recurrence: inputs.frequency.value ? {
              frequency: inputs.frequency.value,
              time: inputs.scheduleTime.value.length === 5 ? `${inputs.scheduleTime.value}:00` : inputs.scheduleTime.value,
              day: inputs.scheduleDay.value
            } : null
          }
        };
        const result = definition
          ? await command("editPane", { paneId: id, name: pane.name, profile: edited, readOnly: pane.readOnly, plan: pane.plan })
          : await command("addPane", { tabId: tab.id, targetPaneId: tab.activePaneId, axis: null, floating: inputs.floating.checked, pane });
        if (result && inputs.saveProfile.checked) await command("saveProfile", edited);
        if (result && inputs.x) await command("floatingBounds", { paneId: id, x: Number(inputs.x.value), y: Number(inputs.y.value),
          width: Number(inputs.width.value), height: Number(inputs.height.value) });
        return result;
      });
  }

  function localDateTime(value) {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function openTabOptions(id = activeTab().id) {
    const tab = state.document.workspace.tabs.find(item => item.id === id);
    showDialog("Tab options", "Reordering, renaming and duplicating configurations never restart existing processes.", "Save tab", body => {
      const grid = element("div", "form-grid");
      body.append(grid);
      field(grid, "name", "Tab name", "text", tab.name, { required: true, maxLength: 100 });
      field(grid, "accentColor", "Tab accent", "color", tab.accentColor);
      const row = element("div", "list-row");
      for (const [text, action] of [["Move left", "left"], ["Move right", "right"], ["Duplicate tab", "duplicate"], ["Close tab", "close"]]) {
        const item = element("button", "", text);
        item.type = "button";
        item.addEventListener("click", () => safely(async () => {
          const index = state.document.workspace.tabs.findIndex(candidate => candidate.id === id);
          if (action === "left" || action === "right")
            await command("reorderTab", { tabId: id, index: clamp(index + (action === "left" ? -1 : 1), 0, state.document.workspace.tabs.length - 1) });
          else {
            const result = await command(action === "duplicate" ? "duplicateTab" : "closeTab", { tabId: id });
            if (result) closeDialog();
          }
        }));
        row.append(item);
      }
      body.append(row);
    }, data => command("renameTab", { tabId: id, name: data.get("name").trim(), accentColor: data.get("accentColor") }));
  }

  function openSettings() {
    const settings = clone(state.document.settings);
    showDialog("Appearance and keyboard", "Changes apply immediately to all terminals without restarting shells. Application shortcuts take precedence over terminal keys; IME/AltGr input is left alone.",
      "Apply settings", body => {
        const grid = element("div", "form-grid");
        body.append(grid);
        field(grid, "theme", "Theme", "select", settings.theme, { items: [["system", "Follow Windows"], ["dark", "Dark"], ["light", "White / Light"]] });
        field(grid, "fontSize", "Terminal font size", "number", settings.fontSize, { required: true, min: 10, max: 32 });
        field(grid, "fontFamily", "Terminal font family", "text", settings.fontFamily, { required: true, full: true });
        field(grid, "scrollback", "Scrollback lines per pane", "number", settings.scrollback, { required: true, min: 100, max: 50000 });
        checkbox(grid, "screenReaderMode", "Enable screen-reader terminal output", settings.screenReaderMode);
        checkbox(grid, "preventSleep", "Prevent automatic sleep / hibernation while app is open", settings.preventSleep);
        field(grid, "shortcuts", "Keyboard shortcuts (JSON action: gesture)", "textarea", JSON.stringify(settings.shortcuts, null, 2), { full: true, rows: 13 });
        body.append(element("p", "form-note", "Ctrl+Shift+C: copy selection. Ctrl+V / Ctrl+Shift+V / Shift+Insert: confirmed native paste. Ctrl+C: terminal interrupt. Shortcuts can be removed from the JSON to let the shell receive those keys."));
        body.append(element("p", "form-note", "Enable terminal screen-reader output only when needed: xterm changes browser text-insertion/emoji handling in that mode. Verify your screen-reader and IME combination."));
        body.append(element("p", "form-note", "Keep-awake needs no administrator rights and does not change Windows power settings. The display may turn off. Manual sleep/hibernate, shutdown, lid and critical-battery policies can still stop work. Leave the app open for schedules; closing it disarms them. Main window size and maximized state are remembered automatically."));
      }, data => command("settings", {
        ...settings,
        theme: data.get("theme"), fontFamily: data.get("fontFamily").trim(), fontSize: Number(data.get("fontSize")),
        scrollback: Number(data.get("scrollback")), screenReaderMode: data.has("screenReaderMode"),
        preventSleep: data.has("preventSleep"), shortcuts: JSON.parse(data.get("shortcuts"))
      }));
  }

  function scheduleSummary(recurrence) {
    const frequency = { daily: "Daily", weekdays: "Weekdays", weekly: `Weekly (${recurrence.day})` };
    return `${frequency[recurrence.frequency]} at ${recurrence.time} (local time)`;
  }

  function openSchedules() {
    showDialog("Recurring agent tasks",
      "Run only while this app is open. Each schedule requires native review and must be re-armed after restart. Running or queued panes are never interrupted; missed runs are not replayed.",
      null, body => {
        const render = () => {
          body.replaceChildren();
          const configured = state.document.workspace.tabs.flatMap(tab => tab.panes
            .filter(pane => pane.plan.recurrence || state.schedules?.some(item => item.paneId === pane.id))
            .map(pane => ({ tab, pane })));
          if (!configured.length)
            body.append(element("p", "form-note", "Edit a pane, add a startup script, then choose a daily, weekday or weekly recurrence."));
          for (const { tab, pane } of configured) {
            const armed = state.schedules?.find(item => item.paneId === pane.id);
            const row = element("div", "list-row");
            row.append(element("span", "", `${tab.name} / ${pane.name}\n` +
              `${scheduleSummary(armed?.recurrence || pane.plan.recurrence)}\n` +
              (armed ? `Next: ${new Date(armed.nextRun).toLocaleString()}\n${armed.message}` : "Not armed")));
            const edit = element("button", "", "Configure");
            edit.type = "button";
            edit.addEventListener("click", () => safely(async () => {
              await command("focusPane", { paneId: pane.id });
              openPaneEditor(pane.id);
            }));
            row.append(edit, button(armed ? "Disarm schedule" : "Review and arm", armed ? "cancelSchedule" : "armSchedule", pane.id));
            body.append(row);
          }
          const configure = element("button", "", "Configure active pane...");
          configure.type = "button";
          configure.addEventListener("click", () => openPaneEditor(activePane()?.id));
          body.append(configure);
        };
        refreshSchedules = render;
        render();
      }, null, () => { refreshSchedules = null; });
  }

  function openProfiles() {
    showDialog("Launch profiles", "Profiles are copied into panes. Editing a reusable profile does not change any existing process or pane configuration.", null, body => {
      for (const profile of state.document.profiles) {
        const row = element("div", "list-row");
        row.append(element("span", "", `${profile.name} - ${profile.executable}`));
        const edit = element("button", "", "Edit");
        edit.type = "button";
        edit.addEventListener("click", () => openPaneEditor(null, profile, true));
        const remove = element("button", "danger", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => safely(async () => { await command("deleteProfile", { id: profile.id }); openProfiles(); }));
        row.append(edit, remove);
        body.append(row);
      }
      const add = element("button", "", "New launch profile");
      add.type = "button";
      add.addEventListener("click", () => openPaneEditor(null, { ...(state.document.profiles[0] || activePane()?.profile),
        id: crypto.randomUUID(), name: "New profile" }, true));
      body.append(add);
    });
  }

  function openTemplates() {
    showDialog("Workspace templates", "Templates create new, stopped panes with fresh identities. Their scripts are reviewed only when you choose to start them.", null, body => {
      for (const template of state.document.templates) {
        const row = element("div", "list-row");
        row.append(element("span", "", `${template.name} (${template.tab.panes.length} panes)`));
        const use = element("button", "", "Create tab");
        use.type = "button";
        use.addEventListener("click", () => safely(async () => { await command("applyTemplate", { id: template.id }); closeDialog(); }));
        const remove = element("button", "danger", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => safely(async () => { await command("deleteTemplate", { id: template.id }); openTemplates(); }));
        row.append(use, remove);
        body.append(row);
      }
      const row = element("div", "list-row");
      const name = element("input");
      name.setAttribute("aria-label", "Template name");
      name.placeholder = "Save current tab as template";
      const save = element("button", "", "Save template");
      save.type = "button";
      save.addEventListener("click", () => safely(async () => {
        await command("saveTemplate", { tabId: activeTab().id, name: name.value.trim() });
        openTemplates();
      }));
      row.append(name, save);
      body.append(row);
    });
  }

  function openSnippets() {
    const snippets = state.document.snippets;
    let currentId = snippets[0]?.id || crypto.randomUUID();
    let name;
    let text;
    showDialog("Prompt snippets", "Review text before explicitly pasting it into one selected pane. Pasting does not deliberately append Enter; multiline text still requires confirmation.", "Save snippet", body => {
      const grid = element("div", "form-grid");
      body.append(grid);
      const selected = field(grid, "selected", "Saved snippet", "select", snippets[0]?.id || "", {
        full: true, items: [["", "New snippet"], ...snippets.map(item => [item.id, item.name])]
      });
      name = field(grid, "name", "Snippet name", "text", snippets[0]?.name || "", { required: true, full: true, maxLength: 100 });
      text = field(grid, "text", "Text to review", "textarea", snippets[0]?.text || "", { full: true, rows: 8 });
      selected.addEventListener("change", () => {
        const snippet = snippets.find(item => item.id === selected.value);
        currentId = snippet?.id || crypto.randomUUID();
        name.value = snippet?.name || "";
        text.value = snippet?.text || "";
      });
      const paste = element("button", "", "Paste reviewed text into active pane");
      paste.type = "button";
      paste.addEventListener("click", () => safely(async () => {
        const pane = activePane();
        if (!pane) throw new Error("Select a running pane first.");
        if (await command("pasteText", { text: text.value }, pane.id, runtimeFor(pane.id).generation)) closeDialog();
      }));
      const remove = element("button", "danger", "Remove selected snippet");
      remove.type = "button";
      remove.addEventListener("click", () => safely(async () => { await command("deleteSnippet", { id: currentId }); openSnippets(); }));
      body.append(paste, document.createTextNode(" "), remove);
    }, () => command("saveSnippet", { id: currentId, name: name.value.trim(), text: text.value }));
  }

  function openMoveDialog(id) {
    const source = ownerTab(id);
    const destinations = state.document.workspace.tabs.filter(tab => tab.id !== source.id);
    if (!destinations.length) throw new Error("Create another tab before moving this pane.");
    showDialog("Move pane to tab", "The terminal emulator, history and process remain the same.", "Move pane", body => {
      const grid = element("div", "form-grid");
      body.append(grid);
      field(grid, "tabId", "Destination tab", "select", destinations[0].id, { full: true, items: destinations.map(tab => [tab.id, tab.name]) });
    }, data => command("movePane", { paneId: id, tabId: data.get("tabId") }));
  }

  function tiledIds(node) { return !node ? [] : node.paneId ? [node.paneId] : [...tiledIds(node.first), ...tiledIds(node.second)]; }

  function openDockDialog(id) {
    const tab = ownerTab(id);
    const targets = tiledIds(tab.root).filter(target => target !== id);
    let target;
    let edge;
    showDialog("Dock pane", "The highlighted half shows the committed placement. Keyboard-accessible alternative to Alt+drag.", "Dock pane", body => {
      const grid = element("div", "form-grid");
      body.append(grid);
      target = field(grid, "target", "Tiled target pane", "select", targets[0] || "", {
        items: targets.length ? targets.map(targetId => [targetId, paneDefinition(targetId).name]) : [["", "Empty tiled workspace"]]
      });
      edge = field(grid, "edge", "Placement", "select", "right", { items: [["left", "Left"], ["right", "Right"], ["above", "Above"], ["below", "Below"]] });
      const preview = () => showDockPreview(tab.id, target.value || null, edge.value);
      target.addEventListener("change", preview);
      edge.addEventListener("change", preview);
      preview();
    }, () => command("dockPane", dockOptions(id, target.value || null, edge.value)), hideDockPreviews);
  }

  function openWorktree() {
    const pane = activePane();
    if (!pane) throw new Error("Select a pane to configure its future working directory.");
    showDialog("Create an isolated Git worktree", "Create a new branch and directory for an independent coding agent. Existing or dirty worktrees are never deleted.", "Review worktree creation", body => {
      const grid = element("div", "form-grid");
      body.append(grid);
      field(grid, "repository", "Existing Git repository", "text", pane.profile.workingDirectory, { required: true, full: true });
      field(grid, "destination", "New worktree directory (must not exist)", "text", "", { required: true, full: true });
      field(grid, "branch", "New branch name", "text", `agent-${pane.id.slice(0, 8)}`, { required: true, full: true });
    }, data => command("worktree", { paneId: pane.id, repository: data.get("repository").trim(),
      destination: data.get("destination").trim(), branch: data.get("branch").trim() }));
  }

  function openBroadcast() {
    const available = state.document.workspace.tabs.flatMap(tab => tab.panes.filter(pane => runtimeFor(pane.id).state === "running" && !pane.readOnly)
      .map(pane => ({ pane, tab, generation: runtimeFor(pane.id).generation })));
    if (!available.length) throw new Error("Start a writable session before enabling broadcast input.");
    showDialog("Broadcast input - deliberate send required", "No recipients are selected automatically. This sends terminal input, not a provider API request. It can execute commands.", "Review and send broadcast", body => {
      $("#broadcast-banner").hidden = false;
      const recipients = element("div", "broadcast-recipients");
      for (const item of available) checkbox(recipients, `recipient-${item.pane.id}`, `${item.tab.name} / ${item.pane.name}`, false);
      body.append(recipients);
      const grid = element("div", "form-grid");
      body.append(grid);
      field(grid, "text", "Input for the explicitly checked sessions", "textarea", "", { full: true, required: true, rows: 6 });
      checkbox(grid, "submit", "Append Enter (can execute immediately)", false);
    }, data => command("broadcast", {
      recipients: available.filter(item => data.has(`recipient-${item.pane.id}`)).map(item => ({ paneId: item.pane.id, generation: item.generation })),
      text: data.get("text"), submit: data.has("submit")
    }), () => { $("#broadcast-banner").hidden = true; });
  }

  function openPalette() {
    const actions = [
      ["New workspace tab", "newTab"], ["Add terminal pane...", "newPane"], ["Split right", "splitHorizontal"], ["Split below", "splitVertical"],
      ["Review and start workspace", "startWorkspace"], ["Float or dock selected pane", "toggleFloat"], ["Maximize or restore pane", "maximize"],
      ["Search terminal", "search"], ["Launch profiles", "profiles"], ["Workspace templates", "templates"], ["Prompt snippets", "snippets"],
      ["Recurring agent task schedules", "schedules"],
      ["Create Git worktree", "worktree"], ["Broadcast input...", "broadcast"], ["Appearance and keyboard shortcuts", "settings"],
      ["Save workspace now", "save"], ["Open workspace layout...", "import"], ["Export layout without scripts...", "export"], ["Help and safety", "help"]
    ].map(([label, action]) => ({ label, run: () => handleAction(action) }));
    for (const tab of state.document.workspace.tabs) {
      actions.push({ label: `Switch tab: ${tab.name}`, run: () => command("selectTab", { tabId: tab.id }) });
      for (const pane of tab.panes) actions.push({ label: `Focus pane: ${tab.name} / ${pane.name}`, run: async () => {
        await command("focusPane", { paneId: pane.id }); focusActive();
      } });
    }
    for (const profile of state.document.profiles)
      actions.push({ label: `Add profile: ${profile.name}`, run: () => openPaneEditor(null, profile) });
    showDialog("Command palette", "Find workspace actions, tabs, panes and launch profiles.", null, body => {
      const filter = element("input", "command-filter");
      filter.type = "search";
      filter.placeholder = "Type a command or pane name";
      filter.setAttribute("aria-label", "Filter commands");
      const list = element("div", "command-list");
      const render = () => {
        list.replaceChildren();
        for (const action of actions.filter(item => item.label.toLowerCase().includes(filter.value.toLowerCase()))) {
          const item = element("button", "", action.label);
          item.type = "button";
          item.addEventListener("click", () => safely(async () => { closeDialog(); await action.run(); }));
          list.append(item);
        }
        if (!list.children.length) list.append(element("p", "form-note", "No matching commands."));
      };
      filter.addEventListener("input", render);
      filter.addEventListener("keydown", event => {
        if (event.key === "ArrowDown") { event.preventDefault(); $("button", list)?.focus(); }
        if (event.key === "Enter") { event.preventDefault(); $("button", list)?.click(); }
      });
      body.append(filter, list);
      render();
    });
  }

  function openHelp() {
    showDialog("About Prompt Terminal", "A local Windows terminal workspace. No agent provider account, orchestration service, automatic transcript or telemetry is used by this app.", null, body => {
      body.append(element("p", "form-note",
        "Each pane owns an independent ConPTY and PowerShell process tree. Tabs and layout changes do not restart sessions. " +
        "Separate shells are not filesystem or security isolation; use Git worktrees for independent edits.\n\n" +
        "Restored/imported workspaces do not execute commands until you review a launch preview. " +
        "Running means only that the shell is alive. Output or silence is never interpreted as completion.\n\n" +
        "Optional explicit PowerShell integration:\n" +
        "Send-PromptTerminalSignal -State working -Message 'Started task'\n" +
        "Send-PromptTerminalSignal -State waiting -Message 'Approval required'\n" +
        "Send-PromptTerminalSignal -State completed -Message 'Tests passed'\n" +
        "Send-PromptTerminalSignal -State directory -Message $PWD.Path\n\n" +
        "Scheduled dependencies require a new explicit completed signal from the prerequisite launch. " +
        "Daily, weekday and weekly tasks must be reviewed and armed for each app session. Busy panes and missed runs are skipped; scheduled shells close when their startup script finishes. " +
        "Enable keep-awake in Settings to prevent automatic idle sleep/hibernation without changing Windows power settings.\n\n" +
        "Metrics report shell-host CPU/memory, not agent process trees.\n\n" +
        "Alt+drag a floating title bar over a tiled pane to preview docking. Splitters support arrow keys. " +
        "Floating position/size can be edited in pane configuration. Use Tab options for keyboard reordering.\n\n" +
        "Closing or stopping forcibly ends only owned process trees. Interrupt with Ctrl+C first when graceful shutdown matters. " +
        "Agent-specific resume commands run only through the explicit Resume action. Clear view does not clear an agent conversation."));
    });
  }

  async function handleAction(action, id, tabId) {
    while (pendingWorkspaceMutation) await pendingWorkspaceMutation;
    if (!state) throw new Error("The desktop workspace is still loading.");
    const paneId = id || activePane()?.id;
    const tab = activeTab();
    const requirePane = () => { if (!paneId) throw new Error("Add or select a pane first."); return paneId; };
    switch (action) {
      case "newTab": return command("newTab", { name: `Workspace ${state.document.workspace.tabs.length + 1}` });
      case "selectTab": return command("selectTab", { tabId });
      case "closeTab": return command("closeTab", { tabId: tabId || tab.id });
      case "tabOptions": return openTabOptions();
      case "newPane": return openPaneEditor();
      case "editPane": return openPaneEditor(requirePane());
      case "splitHorizontal":
      case "splitVertical":
      case "duplicatePane":
        if (!paneId) return openPaneEditor();
        return command("splitPane", { paneId, axis: action === "splitVertical" ? "vertical" : "horizontal" });
      case "startWorkspace": return command("startWorkspace", { tabId: tab.id });
      case "startPane":
      case "restartPane":
      case "resumePane":
      case "interrupt":
      case "stopPane":
      case "armSchedule":
      case "cancelSchedule":
      case "closePane":
      case "maximize":
      case "readOnly":
      case "clearView": return command(action, { paneId: requirePane() });
      case "toggleFloat": {
        const selected = ownerTab(requirePane());
        if (selected.floating.some(item => item.paneId === paneId)) return openDockDialog(paneId);
        return command("toggleFloat", { paneId });
      }
      case "dockPane": return openDockDialog(requirePane());
      case "movePane": return openMoveDialog(requirePane());
      case "copy": return command("copy", { text: panes.get(requirePane()).terminal.getSelection() });
      case "paste": return command("paste", {}, requirePane(), runtimeFor(paneId).generation);
      case "transcript": {
        const terminal = panes.get(requirePane()).terminal;
        const buffer = terminal.buffer.active;
        const lines = [];
        for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index).translateToString(true));
        return command("transcript", { text: lines.join("\r\n") }, paneId, runtimeFor(paneId).generation);
      }
      case "search":
        requirePane();
        $("#search-bar").hidden = false;
        $("#search-query").focus();
        return;
      case "searchNext":
      case "searchPrevious": {
        const search = panes.get(requirePane()).search;
        const found = action === "searchNext" ? search.findNext($("#search-query").value) : search.findPrevious($("#search-query").value);
        $("#search-result").textContent = found ? "Match found" : "No matches";
        return;
      }
      case "closeSearch": $("#search-bar").hidden = true; focusActive(); return;
      case "profiles": return openProfiles();
      case "templates": return openTemplates();
      case "snippets": return openSnippets();
      case "schedules": return openSchedules();
      case "worktree": return openWorktree();
      case "settings": return openSettings();
      case "broadcast": return openBroadcast();
      case "palette": return openPalette();
      case "help": return openHelp();
      case "save":
      case "recover":
      case "import": return command(action);
      case "export": return command("export", { includeScripts: false });
      case "exportScripts": return command("export", { includeScripts: true });
      case "fontSmaller":
      case "fontLarger":
        return command("settings", { ...state.document.settings, fontSize: clamp(state.document.settings.fontSize + (action === "fontLarger" ? 1 : -1), 10, 32) });
      case "nextTab":
      case "previousTab": {
        const all = state.document.workspace.tabs;
        const index = all.findIndex(item => item.id === tab.id);
        return command("selectTab", { tabId: all[(index + (action === "nextTab" ? 1 : all.length - 1)) % all.length].id });
      }
      case "nextPane":
      case "previousPane": {
        if (!tab.panes.length) return;
        const index = tab.panes.findIndex(item => item.id === tab.activePaneId);
        const target = tab.panes[(index + (action === "nextPane" ? 1 : tab.panes.length - 1)) % tab.panes.length];
        await command("focusPane", { paneId: target.id });
        focusActive();
        return;
      }
      default: throw new Error(`Unknown action: ${action}`);
    }
  }

  document.addEventListener("click", event => {
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const menu = control.closest("details");
    if (menu) menu.open = false;
    safely(() => handleAction(control.dataset.action, control.dataset.paneId, control.dataset.tabId));
  });

  function normalizedGesture(value) {
    const parts = value.toLowerCase().split("+");
    const key = parts.pop();
    return ["ctrl", "alt", "shift"].filter(modifier => parts.includes(modifier)).concat(key).join("+");
  }

  document.addEventListener("keydown", event => {
    if (event.isComposing || event.getModifierState("AltGraph") || !state) return;
    if (event.key === "Escape" && drag) { finishDrag(true); event.preventDefault(); return; }
    if ($("#app-dialog").open) return;
    const typingInForm = event.target.closest("input, textarea, select") && !event.target.classList.contains("xterm-helper-textarea");
    if (typingInForm) return;
    const gesture = [...(event.ctrlKey ? ["ctrl"] : []), ...(event.altKey ? ["alt"] : []), ...(event.shiftKey ? ["shift"] : []), event.key.toLowerCase()].join("+");
    const shortcut = Object.entries(state.document.settings.shortcuts).find(([, value]) => normalizedGesture(value) === gesture);
    if (shortcut) {
      event.preventDefault();
      event.stopImmediatePropagation();
      safely(() => handleAction(shortcut[0]));
      return;
    }
    if (event.target.closest(".tab") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      safely(async () => {
        if (event.key === "Home" || event.key === "End") {
          const all = state.document.workspace.tabs;
          await command("selectTab", { tabId: all[event.key === "Home" ? 0 : all.length - 1].id });
        } else await handleAction(event.key === "ArrowRight" ? "nextTab" : "previousTab");
        $('.tab[aria-selected="true"]')?.focus();
      });
      return;
    }
    if (!event.target.closest(".pane")) return;
    const copy = event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c";
    const paste = (event.ctrlKey && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert");
    if (copy || paste) {
      event.preventDefault();
      event.stopImmediatePropagation();
      safely(() => handleAction(copy ? "copy" : "paste"));
    }
  }, true);

  document.addEventListener("paste", event => {
    if (!event.target.closest(".pane")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    safely(() => handleAction("paste"));
  }, true);
  $("#search-query").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); safely(() => handleAction(event.shiftKey ? "searchPrevious" : "searchNext")); }
    if (event.key === "Escape") safely(() => handleAction("closeSearch"));
  });

  const observer = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!drag) renderLayouts();
    });
  });
  observer.observe($("#workspaces"));
  document.fonts.ready.then(() => { if (state) renderLayouts(); });
  if (host) {
    host.addEventListener("message", event => {
      try { receive(event.data); }
      catch (error) {
        notice(`Renderer error: ${error.message}`, true);
        post("rendererError", { text: error.message });
      }
    });
    post("ready");
  } else notice("The desktop bridge is unavailable. Run PromptTerminal.App.exe to use real PowerShell terminals.", true);
})();
