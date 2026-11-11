const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { documentFixture, installMockHost } = require("./mock-host.cjs");

let browser;
before(async () => { browser = await chromium.launch({ channel: "msedge", headless: true }); });
after(async () => { if (browser) await browser.close(); });

async function withPage(run, fixture = documentFixture()) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await installMockHost(page, fixture);
    await page.goto(pathToFileURL(path.resolve(__dirname, "..", "..", "src", "PromptTerminal.App", "Web", "index.html")).href);
    await page.waitForSelector(".pane");
    await run(page, fixture);
    assert.deepEqual(errors, [], "No uncaught renderer errors");
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "rendererError").length), 0);
  } finally { await page.close(); }
}

async function emitOutput(page, paneId, text, sequence = 1, generation = 1) {
  await page.evaluate(message => window.__host.emit({ type: "output", ...message }), { paneId, text, sequence, generation });
  await page.waitForFunction(({ paneId, sequence, generation }) => window.__host.messages.some(message =>
    message.type === "outputAck" && message.paneId === paneId && message.generation === generation && message.data.sequence === sequence),
  { paneId, sequence, generation });
}

async function transcript(page, paneId) {
  const pane = page.locator(`.pane[data-pane-id="${paneId}"]`);
  await pane.locator("summary").click();
  await pane.getByRole("button", { name: "Export transcript..." }).click();
  await page.waitForFunction(paneId => window.__host.messages.some(message => message.type === "transcript" && message.paneId === paneId), paneId);
  return page.evaluate(paneId => window.__host.messages.filter(message => message.type === "transcript" && message.paneId === paneId).at(-1).data.text, paneId);
}

test("branding uses the spaced app title and red command-prompt icon in both themes", async () => {
  await withPage(async page => {
    assert.equal(await page.title(), "Prompt Terminal");
    assert.match(await page.locator(".brand").innerText(), /^Prompt Terminal/);
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "app-icon.svg");
    assert.equal(await page.locator(".brand-icon").getAttribute("src"), "app-icon.svg");
    const source = await fs.readFile(path.resolve(__dirname, "..", "..", "src", "PromptTerminal.App", "Web", "app-icon.svg"), "base64");
    const colors = await page.locator(".brand-icon").evaluate(async (displayedImage, source) => {
      await displayedImage.decode();
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${source}`;
      await image.decode();
      const sample = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, 256, 256);
        return {
          background: Array.from(context.getImageData(128, 128, 1, 1).data),
          prompt: Array.from(context.getImageData(152, 176, 1, 1).data)
        };
      };
      const dark = sample();
      document.documentElement.dataset.theme = "light";
      return { dark, light: sample() };
    }, source);
    assert.deepEqual(colors.dark.background, [185, 28, 28, 255]);
    assert.deepEqual(colors.dark.prompt, [255, 255, 255, 255]);
    assert.deepEqual(colors.light, colors.dark);
  });
});

test("mounts twelve independent terminal views without auto-starting shells", async () => {
  await withPage(async page => {
    assert.equal(await page.locator(".pane").count(), 12);
    assert.equal(await page.getByRole("tab").count(), 3);
    assert.equal(await page.locator(".pane[data-state='notStarted']").count(), 12);
    assert.equal(await page.evaluate(() => window.__host.messages.some(message => message.type.startsWith("start"))), false);
    assert.equal(await page.getByRole("button", { name: "Start workspace", exact: true }).count(), 1);
    const dimensions = await page.locator(".workspace:not(.is-inactive) .pane").evaluateAll(nodes =>
      nodes.map(node => ({ width: node.clientWidth, height: node.clientHeight })));
    assert.ok(dimensions.every(size => size.width >= 318 && size.height >= 208));
  }, documentFixture(3, 4));
});

test("processes ANSI/Unicode in order, acknowledges parsed batches and rejects stale generations", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.evaluate(() => window.__host.running());
    await emitOutput(page, id, "\x1b[31mred\x1b[0m \u03bb \u4e2d\r\n", 1);
    await emitOutput(page, id, "ordered-second\r\n", 2);
    await page.evaluate(({ id }) => {
      window.__host.emit({ type: "output", paneId: id, generation: 0, sequence: 3, text: "STALE-MUST-NOT-APPEAR" });
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 2, text: "DUPLICATE-MUST-NOT-APPEAR" });
    }, { id });
    const text = await transcript(page, id);
    assert.match(text, /red \u03bb \u4e2d/);
    assert.match(text, /ordered-second/);
    assert.doesNotMatch(text, /STALE|DUPLICATE|\x1b/);
  });
});

test("a restart cannot render bytes already queued in the previous terminal parser", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.evaluate(id => {
      window.__host.running();
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 1, text: "OLD-GENERATION".repeat(512) });
      window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).generation = 2;
      window.__host.publish();
      window.__host.emit({ type: "output", paneId: id, generation: 2, sequence: 1, text: "CURRENT-ONLY\r\n" });
    }, id);
    await page.waitForFunction(id => window.__host.messages.some(message => message.type === "outputAck" && message.paneId === id && message.generation === 2), id);
    const text = await transcript(page, id);
    assert.match(text, /CURRENT-ONLY/);
    assert.doesNotMatch(text, /OLD-GENERATION/);
  });
});
test("live themes, tab changes and cross-tab pane moves retain the same terminal and history", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.evaluate(() => window.__host.running());
    await emitOutput(page, id, "preserved-history-73\r\n");
    await page.evaluate(id => { window.__terminalBefore = document.querySelector(`[data-pane-id="${id}"] .xterm`); }, id);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption("light");
    await page.getByLabel("Enable screen-reader terminal output", { exact: true }).check();
    await page.getByRole("button", { name: "Apply settings", exact: true }).click();
    await page.waitForSelector("html[data-theme='light']");
    assert.equal(await page.locator(".xterm-viewport").first().evaluate(node => getComputedStyle(node).backgroundColor), "rgb(255, 255, 255)");
    assert.equal(await page.locator(".xterm-scrollable-element").first().evaluate(node => getComputedStyle(node).backgroundColor), "rgb(255, 255, 255)");
    assert.ok(await page.locator(".xterm-accessibility").count() > 0);
    await page.evaluate(id => {
      const state = window.__host.snapshot;
      const source = state.document.workspace.tabs[0];
      const destination = state.document.workspace.tabs[1];
      const pane = source.panes.shift();
      source.root = source.root.second;
      source.activePaneId = source.panes[0].id;
      destination.root = { id: crypto.randomUUID(), paneId: null, axis: "vertical", ratio: .5,
        first: destination.root, second: { id: crypto.randomUUID(), paneId: pane.id, axis: "horizontal", ratio: .5, first: null, second: null } };
      destination.panes.push(pane);
      destination.activePaneId = id;
      state.document.workspace.activeTabId = destination.id;
      window.__host.publish();
    }, id);
    assert.equal(await page.evaluate(id => window.__terminalBefore === document.querySelector(`[data-pane-id="${id}"] .xterm`), id), true);
    assert.match(await transcript(page, id), /preserved-history-73/);
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => ["startPane", "restartPane"].includes(message.type)).length), 0);
  });
});

test("only the focused writable pane emits input and application shortcuts have precedence", async () => {
  await withPage(async (page, fixture) => {
    const first = fixture.workspace.tabs[0].panes[0].id;
    const second = fixture.workspace.tabs[0].panes[1].id;
    await page.evaluate(() => window.__host.running());
    await page.locator(`[data-pane-id="${second}"] textarea`).focus();
    await page.keyboard.type("agent-input");
    await page.waitForFunction(() => window.__host.messages.filter(message => message.type === "input").map(message => message.data.text).join("").includes("agent-input"));
    const input = await page.evaluate(() => window.__host.messages.filter(message => message.type === "input"));
    assert.ok(input.every(message => message.paneId === second && message.generation === 1));
    assert.equal(input.some(message => message.paneId === first), false);
    await page.keyboard.press("Control+Shift+T");
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "newTab"));
    await page.evaluate(id => {
      window.__host.snapshot.document.workspace.tabs[0].panes.find(pane => pane.id === id).readOnly = true;
      window.__host.publish();
    }, second);
    const count = await page.evaluate(() => window.__host.messages.filter(message => message.type === "input").length);
    await page.keyboard.type("blocked");
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "input").length), count);
  });
});

test("Unicode text input reaches the desktop bridge without losing characters", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.evaluate(() => window.__host.running());
    await page.locator(`.pane[data-pane-id="${id}"] textarea`).focus();
    await page.keyboard.type("A\u03bb\u4e2d");
    const text = await page.evaluate(() => window.__host.messages.filter(message => message.type === "input").map(message => message.data.text).join(""));
    assert.equal(text, "A\u03bb\u4e2d");
  });
});
test("floating drag commits geometry and docking offers a visible keyboard-accessible preview", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    const target = fixture.workspace.tabs[0].panes[1].id;
    await page.evaluate(id => {
      const tab = window.__host.snapshot.document.workspace.tabs[0];
      tab.root = tab.root.second;
      tab.floating.push({ paneId: id, x: 70, y: 80, width: 600, height: 360, z: 1 });
      window.__host.publish();
    }, id);
    const pane = page.locator(`[data-pane-id="${id}"]`);
    const header = await pane.locator(".pane-header").boundingBox();
    await page.mouse.move(header.x + 3, header.y + 16);
    await page.mouse.down();
    await page.mouse.move(header.x + 83, header.y + 66, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "floatingBounds"));
    const bounds = await page.evaluate(() => window.__host.messages.find(message => message.type === "floatingBounds").data);
    assert.ok(bounds.x > 70 && bounds.y > 80);
    await pane.locator("summary").click();
    await pane.getByRole("button", { name: "Dock with placement preview..." }).click();
    assert.equal(await page.locator(".dock-preview:not([hidden])").count(), 1);
    await page.getByLabel("Placement", { exact: true }).selectOption("left");
    await page.getByRole("button", { name: "Dock pane", exact: true }).click();
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "dockPane"));
    const dock = await page.evaluate(() => window.__host.messages.find(message => message.type === "dockPane").data);
    assert.deepEqual(dock, { paneId: id, targetPaneId: target, axis: "horizontal", before: true });
  });
});

test("rapid tab selection followed by Start targets the newly selected workspace", async () => {
  await withPage(async (page, fixture) => {
    const tabId = fixture.workspace.tabs[1].id;
    await page.evaluate(tabId => {
      document.querySelector(`.tab[data-tab-id="${tabId}"]`).click();
      document.querySelector('[data-action="startWorkspace"]').click();
    }, tabId);
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "startWorkspace"));
    const target = await page.evaluate(() => window.__host.messages.find(message => message.type === "startWorkspace").data.tabId);
    assert.equal(target, tabId);
  });
});

test("keep-awake is opt-in, can be disabled, and preserves live terminal instances", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.evaluate(id => {
      window.__host.running();
      window.__powerTerminal = document.querySelector(`[data-pane-id="${id}"] .xterm`);
    }, id);
    assert.equal(await page.locator("#power-status").innerText(), "Sleep allowed");
    for (const enabled of [true, false]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Prevent automatic sleep / hibernation while app is open").setChecked(enabled);
      await page.getByRole("button", { name: "Apply settings", exact: true }).click();
      assert.equal(await page.locator("#power-status").innerText(), enabled ? "Keep-awake on" : "Sleep allowed");
      assert.equal(await page.evaluate(() => window.__host.snapshot.document.settings.preventSleep), enabled);
    }
    assert.equal(await page.evaluate(id =>
      window.__powerTerminal === document.querySelector(`[data-pane-id="${id}"] .xterm`), id), true);
  });
});

test("new panes default to the existing floating format and allow a deliberate tiled override", async () => {
  const fixture = documentFixture(1, 2);
  const tab = fixture.workspace.tabs[0];
  const floating = tab.panes[0].id;
  tab.root = tab.root.second;
  tab.floating.push({ paneId: floating, x: 25, y: 60, width: 640, height: 420, z: 1 });
  tab.activePaneId = tab.panes[1].id;
  await withPage(async page => {
    for (const desired of [true, false]) {
      await page.getByRole("button", { name: "+ Pane", exact: true }).click();
      assert.equal(await page.getByLabel("Create as floating panel").isChecked(), true);
      await page.getByLabel("Create as floating panel").setChecked(desired);
      await page.getByRole("button", { name: "Add unstarted pane", exact: true }).click();
      const request = await page.evaluate(() => window.__host.messages.filter(message => message.type === "addPane").at(-1));
      assert.equal(request.data.floating, desired);
      assert.equal(request.data.axis, null);
      assert.equal(request.data.pane.plan.recurrence, null);
    }
    assert.equal(await page.evaluate(() => window.__host.messages.some(message =>
      ["startPane", "armSchedule"].includes(message.type))), false);
  }, fixture);
});

test("daily and weekly schedules are configured without execution and must be explicitly armed or disarmed", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.locator(`[data-pane-id="${id}"] .pane-name`).click();
    assert.equal(await page.getByLabel("Recurring local time", { exact: true }).isDisabled(), true);
    await page.getByLabel("Startup command or multiline PowerShell script").fill("agent run 'Daily review'");
    await page.getByLabel("Recurring task", { exact: true }).selectOption("daily");
    await page.getByLabel("Recurring local time", { exact: true }).fill("09:35");
    assert.equal(await page.getByLabel("Weekly day", { exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    const daily = await page.evaluate(() => window.__host.messages.filter(message => message.type === "editPane").at(-1).data.plan.recurrence);
    assert.deepEqual(daily, { frequency: "daily", time: "09:35:00", day: "monday" });
    assert.equal(await page.evaluate(() => window.__host.messages.some(message =>
      ["startPane", "armSchedule"].includes(message.type))), false);
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    assert.match(await page.locator("#dialog-body").innerText(), /Daily at 09:35:00.*local time/);
    await page.getByRole("button", { name: "Review and arm", exact: true }).click();
    await page.waitForFunction(() => window.__host.snapshot.schedules.length === 1);
    assert.match(await page.locator("#dialog-body").innerText(), /Armed for this app session/);
    await page.getByRole("button", { name: "Disarm schedule", exact: true }).click();
    assert.match(await page.locator("#dialog-body").innerText(), /Not armed/);
    await page.getByRole("button", { name: "Configure", exact: true }).click();
    await page.getByLabel("Recurring task", { exact: true }).selectOption("weekly");
    await page.getByLabel("Weekly day", { exact: true }).selectOption("friday");
    await page.getByLabel("Recurring local time", { exact: true }).fill("14:20:30");
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    const weekly = await page.evaluate(() => window.__host.messages.filter(message => message.type === "editPane").at(-1).data.plan.recurrence);
    assert.deepEqual(weekly, { frequency: "weekly", time: "14:20:30", day: "friday" });
    assert.equal(await page.locator(`[data-pane-id="${id}"] .pane-schedule`).innerText(), "Schedule not armed");
  });
});

test("broadcast starts with no recipients, and snippets require an explicit single-pane paste", async () => {
  await withPage(async (page, fixture) => {
    await page.evaluate(() => window.__host.running());
    await page.getByRole("button", { name: "Broadcast...", exact: true }).click();
    assert.equal(await page.locator(".broadcast-recipients input:checked").count(), 0);
    assert.equal(await page.locator("#broadcast-banner").isVisible(), true);
    await page.locator(".broadcast-recipients input").first().check();
    await page.getByLabel("Input for the explicitly checked sessions").fill("review this");
    await page.getByRole("button", { name: "Review and send broadcast", exact: true }).click();
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "broadcast"));
    const broadcast = await page.evaluate(() => window.__host.messages.find(message => message.type === "broadcast").data);
    assert.equal(broadcast.recipients.length, 1);
    assert.equal(broadcast.submit, false);
    assert.equal(broadcast.recipients[0].paneId, fixture.workspace.tabs[0].panes[0].id);
    await page.getByRole("button", { name: "Snippets", exact: true }).click();
    await page.getByRole("button", { name: "Paste reviewed text into active pane" }).click();
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "pasteText"));
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "pasteText").length), 1);
  });
});

test("terminal clipboard escape sequences cannot invoke clipboard or privileged commands", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.evaluate(() => window.__host.running());
    await emitOutput(page, id, "\x1b]52;c;c2VjcmV0\x07<img src=x onerror=alert(1)>\r\n");
    assert.equal(await page.locator(".terminal-view img").count(), 0);
    assert.equal(await page.evaluate(() => window.__host.messages.some(message => ["copy", "openLink", "startPane", "broadcast"].includes(message.type))), false);
    assert.match(await transcript(page, id), /<img src=x onerror=alert\(1\)>/);
  });
});

test("default normal-text and terminal colors meet 4.5:1 contrast in both themes", async () => {
  await withPage(async page => {
    const contrast = await page.evaluate(() => {
      const luminance = hex => {
        const rgb = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const results = [];
      for (const theme of ["dark", "light"]) {
        document.documentElement.dataset.theme = theme;
        const css = getComputedStyle(document.documentElement);
        for (const foreground of ["--text", "--muted", "--danger", "--success", "--warning"]) {
          const a = luminance(css.getPropertyValue(foreground).trim());
          const b = luminance(css.getPropertyValue("--surface").trim());
          results.push({ theme, foreground, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
        }
        const a = luminance(css.getPropertyValue("--text").trim());
        const b = luminance(css.getPropertyValue("--terminal").trim());
        results.push({ theme, foreground: "terminal", ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
      }
      return results;
    });
    assert.ok(contrast.every(item => item.ratio >= 4.5), JSON.stringify(contrast));
  });
});
