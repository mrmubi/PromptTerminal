const { randomUUID } = require("node:crypto");

function documentFixture(tabCount = 2, panesPerTab = 2) {
  const profile = {
    id: randomUUID(), name: "PowerShell", executable: "pwsh.exe", workingDirectory: "C:\\work",
    startupScript: "", resumeScript: "", environment: {}, loadUserProfile: false,
    keepShellOpen: true, enableIntegration: true, accentColor: "#7c8aff"
  };
  const tabs = Array.from({ length: tabCount }, (_, tabIndex) => {
    const panes = Array.from({ length: panesPerTab }, (_, paneIndex) => ({
      id: randomUUID(), name: `Agent ${tabIndex + 1}.${paneIndex + 1}`, profile: { ...profile, id: randomUUID() },
      readOnly: false, plan: { notBefore: null, afterPaneId: null, recurrence: null }
    }));
    let root = { id: randomUUID(), paneId: panes[0].id, axis: "horizontal", ratio: .5, first: null, second: null };
    for (const pane of panes.slice(1))
      root = { id: randomUUID(), paneId: null, axis: "horizontal", ratio: .5, first: root,
        second: { id: randomUUID(), paneId: pane.id, axis: "horizontal", ratio: .5, first: null, second: null } };
    return { id: randomUUID(), name: `Project ${tabIndex + 1}`, accentColor: "#7c8aff", panes, root, floating: [], activePaneId: panes[0].id };
  });
  return {
    schemaVersion: 1, workspace: { schemaVersion: 1, tabs, activeTabId: tabs[0].id },
    mainWindow: { width: 1450, height: 900, maximized: false },
    settings: { theme: "dark", fontFamily: "Consolas, monospace", fontSize: 14, scrollback: 10000, screenReaderMode: false, preventSleep: false, shortcuts: {
      newTab: "Ctrl+Shift+T", newPane: "Ctrl+Shift+N", splitHorizontal: "Ctrl+Shift+H", splitVertical: "Ctrl+Shift+J",
      nextTab: "Ctrl+Tab", previousTab: "Ctrl+Shift+Tab", nextPane: "Alt+ArrowRight", previousPane: "Alt+ArrowLeft",
      maximize: "Ctrl+Shift+M", toggleFloat: "Ctrl+Shift+F", palette: "Ctrl+Shift+P", search: "Ctrl+Shift+S"
    } },
    profiles: [profile], snippets: [{ id: randomUUID(), name: "Review", text: "Review this change." }], templates: []
  };
}

async function installMockHost(page, document) {
  await page.addInitScript(document => {
    const listeners = [];
    const snapshot = {
      type: "state", document, resolvedTheme: document.settings.theme === "light" ? "light" : "dark",
      runtimes: [], schedules: [], keepAwakeEnabled: !!document.settings.preventSleep,
      maximized: {}, unreadTabs: [], saveStatus: "Saved locally", autosaveEnabled: true
    };
    const fixture = {
      snapshot, messages: [],
      emit(message) { for (const listener of listeners) listener({ data: structuredClone(message) }); },
      publish(update = {}) { Object.assign(snapshot, update); fixture.emit(snapshot); },
      running() {
        snapshot.runtimes = document.workspace.tabs.flatMap(tab => tab.panes.map((pane, index) => ({
          paneId: pane.id, generation: 1, state: "running", processId: 2000 + index,
          exitCode: null, error: null, signal: null, signalMessage: null, directory: pane.profile.workingDirectory,
          directoryIsLive: false, branch: null, executable: pane.profile.executable
        })));
        fixture.publish();
      }
    };
    window.__host = fixture;
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
      postMessage(message) {
        fixture.messages.push(structuredClone(message));
        if (message.type === "outputAck") return;
        queueMicrotask(() => {
          if (message.type === "ready") fixture.publish();
          if (message.type === "settings") {
            document.settings = message.data;
            snapshot.resolvedTheme = message.data.theme === "light" ? "light" : "dark";
            snapshot.keepAwakeEnabled = message.data.preventSleep;
            fixture.publish();
          }
          if (message.type === "selectTab") {
            document.workspace.activeTabId = message.data.tabId;
            fixture.publish();
          }
          if (message.type === "focusPane") {
            const tab = document.workspace.tabs.find(tab => tab.panes.some(pane => pane.id === message.data.paneId));
            document.workspace.activeTabId = tab.id;
            tab.activePaneId = message.data.paneId;
            fixture.publish();
          }
          if (message.type === "floatingBounds") {
            const tab = document.workspace.tabs.find(tab => tab.floating.some(item => item.paneId === message.data.paneId));
            Object.assign(tab.floating.find(item => item.paneId === message.data.paneId), message.data);
            fixture.publish();
          }
          if (message.type === "editPane") {
            const pane = document.workspace.tabs.flatMap(tab => tab.panes).find(pane => pane.id === message.data.paneId);
            Object.assign(pane, message.data);
            delete pane.paneId;
            fixture.publish();
          }
          if (message.type === "armSchedule") {
            const pane = document.workspace.tabs.flatMap(tab => tab.panes).find(pane => pane.id === message.data.paneId);
            snapshot.schedules = snapshot.schedules.filter(item => item.paneId !== pane.id);
            snapshot.schedules.push({ paneId: pane.id, nextRun: "2026-11-12T09:00:00Z",
              lastRun: null, message: "Armed for this app session", recurrence: structuredClone(pane.plan.recurrence) });
            fixture.publish();
          }
          if (message.type === "cancelSchedule") {
            snapshot.schedules = snapshot.schedules.filter(item => item.paneId !== message.data.paneId);
            fixture.publish();
          }
          fixture.emit({ type: "result", id: message.id, ok: true, cancelled: false, error: null });
        });
      }
    };
  }, document);
}

module.exports = { documentFixture, installMockHost };
