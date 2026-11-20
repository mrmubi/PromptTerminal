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

test("mounts twelve independent terminal views without renderer-triggered launches when startup automation is disabled", async () => {
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

test("live output respects explicit animation states without changing signals, terminal instances or history", async () => {
  await withPage(async (page, fixture) => {
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
    const id = fixture.workspace.tabs[0].panes[0].id;
    const pane = page.locator(`.pane[data-pane-id="${id}"]`);
    await page.evaluate(id => {
      window.__host.running();
      window.__workingTerminal = document.querySelector(`.pane[data-pane-id="${id}"] .xterm`);
    }, id);
    const appearance = () => pane.evaluate(node => ({
      working: node.classList.contains("is-working"),
      border: getComputedStyle(node, "::before").animationName,
      title: getComputedStyle(node.querySelector(".pane-name")).animationName,
      opacity: Number(getComputedStyle(node.querySelector(".pane-name")).opacity)
    }));
    assert.deepEqual(await appearance(), { working: false, border: "none", title: "none", opacity: 1 });
    await emitOutput(page, id, "working-animation-history\r\n");
    for (const signal of ["working", "waiting", "working", "completed", null]) {
      await page.evaluate(({ id, signal }) => {
        window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).signal = signal;
        window.__host.publish();
      }, { id, signal });
      const actual = await appearance();
      const animated = signal !== "completed";
      assert.equal(actual.working, animated);
      assert.equal(actual.border, animated ? "pane-border-orbit" : "none");
      assert.equal(actual.title, animated ? "pane-title-breathe" : "none");
      assert.equal(await pane.evaluate(node => getComputedStyle(node, "::after").boxShadow !== "none"), animated);
      assert.ok(actual.opacity >= .85 && actual.opacity <= 1);
      assert.equal(await page.locator(".pane.is-working").count(), animated ? 1 : 0);
      assert.equal(await pane.locator(".pane-signal").textContent(), signal ? `Integration: ${signal}` : "");
    }
    for (const state of ["queued", "starting", "stopping", "exited", "failed", "notStarted"]) {
      await page.evaluate(({ id, state }) => {
        Object.assign(window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id), { signal: "working", state });
        window.__host.publish();
      }, { id, state });
      assert.deepEqual(await appearance(), { working: false, border: "none", title: "none", opacity: 1 });
    }
    await page.evaluate(id => {
      Object.assign(window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id), { state: "running", signal: null });
      window.__host.publish();
    }, id);
    assert.equal(await page.evaluate(id => window.__workingTerminal ===
      document.querySelector(`.pane[data-pane-id="${id}"] .xterm`), id), true);
    assert.match(await transcript(page, id), /working-animation-history/);
    assert.equal(await page.evaluate(() => window.__host.messages.some(message => ["startPane", "restartPane"].includes(message.type))), false);
  });
});

test("explicit working and waiting keep animating through silence while completed overrides later output", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    const pane = page.locator(`.pane[data-pane-id="${id}"]`);
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60000));
    await page.evaluate(() => window.__host.running());
    const report = signal => page.evaluate(({ id, signal }) => {
      window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).signal = signal;
      window.__host.publish();
    }, { id, signal });
    const animated = () => pane.evaluate(node => node.classList.contains("is-working"));
    for (const signal of ["working", "waiting"]) {
      await report(signal);
      assert.equal(await animated(), true, "Explicit activity does not require terminal output");
      await page.clock.runFor(10000);
      assert.equal(await animated(), true, `${signal} must outlast the output inactivity timeout`);
      assert.equal(await pane.evaluate(node => getComputedStyle(node, "::before").animationName), "pane-border-orbit");
      assert.equal(await pane.locator(".pane-name").evaluate(node => getComputedStyle(node).animationName), "pane-title-breathe");
      assert.equal(await pane.locator(".pane-signal").textContent(), `Integration: ${signal}`);
      assert.equal(await page.locator(".pane.is-working").count(), 1);
    }
    await report("completed");
    assert.equal(await animated(), false, "Completion stops animation immediately");
    await page.evaluate(id => {
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 1, text: "Output after completion\r\n" });
    }, id);
    await page.clock.runFor(100);
    assert.equal(await animated(), false, "Post-completion output must not restart animation");
    assert.equal(await pane.locator(".pane-signal").textContent(), "Integration: completed");
    await report("waiting");
    assert.equal(await animated(), true, "A new activity signal can resume animation");
    await page.evaluate(id => {
      window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).state = "exited";
      window.__host.publish();
    }, id);
    assert.equal(await animated(), false, "An exited process cannot remain animated");
    await page.evaluate(id => {
      Object.assign(window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id),
        { generation: 2, state: "running", signal: null });
      window.__host.publish();
      window.__host.emit({ type: "output", paneId: id, generation: 2, sequence: 1, text: "New session output\r\n" });
    }, id);
    assert.equal(await animated(), true, "A new session retains automatic output detection");
    await page.clock.runFor(2000);
    assert.equal(await animated(), false);
  });
});

test("output activity expires at two quiet seconds and ignores state refreshes, replays and empty output", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    const pane = page.locator(`.pane[data-pane-id="${id}"]`);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60000));
    await page.evaluate(id => {
      window.__host.running();
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 1, text: "First output\r\n" });
    }, id);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), true);
    await page.clock.runFor(1000);
    await page.evaluate(id => {
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 2, text: "More output\r\n" });
      window.__host.publish();
    }, id);
    await page.clock.runFor(1999);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), true);
    await page.clock.runFor(1);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), false);
    assert.equal(await pane.locator(".pane-signal").textContent(), "",
      "Visual inactivity does not invent an integration state");
    await page.evaluate(id => {
      window.__host.emit({ type: "output", paneId: id, generation: 0, sequence: 3, text: "STALE" });
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 2, text: "REPLAY" });
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 3, text: "" });
      window.__host.publish();
    }, id);
    await page.clock.runFor(10);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), false);
    assert.equal(await page.evaluate(id => window.__host.messages.some(message =>
      message.type === "outputAck" && message.paneId === id && message.data.sequence === 3), id), true);
  });
});

test("output activity survives startup ordering but cannot leak across generations, exits or pane removal", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    const pane = page.locator(`.pane[data-pane-id="${id}"]`);
    await page.clock.install();
    await page.evaluate(id => {
      window.__host.running();
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 1, text: "Old session\r\n" });
    }, id);
    await page.clock.runFor(1000);
    await page.evaluate(id => {
      Object.assign(window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id), { generation: 2, state: "starting" });
      window.__host.publish();
      window.__host.emit({ type: "output", paneId: id, generation: 1, sequence: 2, text: "STALE" });
      window.__host.emit({ type: "output", paneId: id, generation: 2, sequence: 1, text: "New session startup\r\n" });
    }, id);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), false);
    await page.evaluate(id => {
      window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).state = "running";
      window.__host.publish();
    }, id);
    await page.clock.runFor(1000);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), true);
    await page.evaluate(id => {
      window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).state = "exited";
      window.__host.publish();
    }, id);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), false);
    await page.evaluate(id => {
      window.__host.snapshot.runtimes.find(runtime => runtime.paneId === id).state = "running";
      window.__host.publish();
    }, id);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), false);
    await page.evaluate(id => {
      window.__host.emit({ type: "output", paneId: id, generation: 2, sequence: 2, text: "Fresh activity\r\n" });
      const tab = window.__host.snapshot.document.workspace.tabs[0];
      tab.panes = tab.panes.filter(pane => pane.id !== id);
      tab.root = tab.root.second;
      tab.activePaneId = tab.panes[0].id;
      window.__host.publish();
    }, id);
    assert.equal(await pane.count(), 0);
    await page.clock.runFor(2001);
    assert.equal(await page.locator(".pane.is-working").count(), 0);
  });
});

test("working borders rotate and titles subtly breathe in both themes with accessible static alternatives", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    const pane = page.locator(`.pane[data-pane-id="${id}"]`);
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
    await page.evaluate(() => window.__host.running());
    let sequence = 0;
    for (const theme of ["dark", "light"]) {
      await emitOutput(page, id, "Activity without integration signals\r\n", ++sequence);
      await page.evaluate(theme => window.__host.publish({ resolvedTheme: theme }), theme);
      const angle = await pane.evaluate(node => getComputedStyle(node, "::before").getPropertyValue("--pane-working-angle"));
      await page.waitForFunction(({ id, angle }) => {
        const node = document.querySelector(`.pane[data-pane-id="${id}"]`);
        return getComputedStyle(node, "::before").getPropertyValue("--pane-working-angle") !== angle;
      }, { id, angle });
      const fade = await pane.locator(".pane-name").evaluate(node => {
        const animation = node.getAnimations().find(animation => animation.animationName === "pane-title-breathe");
        animation.pause();
        animation.currentTime = animation.effect.getTiming().duration / 2;
        return { opacity: Number(getComputedStyle(node).opacity), duration: animation.effect.getTiming().duration };
      });
      assert.ok(fade.opacity >= .85 && fade.opacity <= .9);
      assert.ok(fade.duration >= 2000);
      const border = await pane.evaluate(node => ({
        thickness: getComputedStyle(node, "::before").paddingTop,
        gradient: getComputedStyle(node, "::before").backgroundImage,
        headerColor: getComputedStyle(node.querySelector(".pane-header")).borderTopColor,
        glow: getComputedStyle(node, "::after").boxShadow,
        pointerEvents: [getComputedStyle(node, "::before").pointerEvents, getComputedStyle(node, "::after").pointerEvents]
      }));
      assert.equal(border.thickness, "3px");
      assert.equal(border.headerColor, theme === "dark" ? "rgb(255, 77, 94)" : "rgb(201, 37, 61)");
      assert.ok(border.gradient.includes(border.headerColor));
      assert.notEqual(border.glow, "none");
      assert.deepEqual(border.pointerEvents, ["none", "none"]);
    }
    await emitOutput(page, id, "Activity for accessibility checks\r\n", ++sequence);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.deepEqual(await pane.evaluate(node => ({
      border: getComputedStyle(node, "::before").animationName,
      title: getComputedStyle(node.querySelector(".pane-name")).animationName,
      opacity: getComputedStyle(node.querySelector(".pane-name")).opacity,
      background: getComputedStyle(node, "::before").backgroundImage
    })), { border: "none", title: "none", opacity: "1", background: "none" });
    assert.equal(await pane.locator(".pane-signal").textContent(), "");
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
    assert.equal(await pane.evaluate(node => getComputedStyle(node, "::before").animationName), "none");
    assert.equal(await pane.evaluate(node => getComputedStyle(node, "::after").boxShadow), "none");
    assert.equal(await pane.locator(".pane-name").evaluate(node => getComputedStyle(node).animationName), "none");
    await page.emulateMedia({ forcedColors: "none" });
    await page.getByRole("tab").nth(1).click();
    assert.equal(await pane.evaluate(node => getComputedStyle(node, "::before").animationPlayState), "paused");
    assert.equal(await pane.locator(".pane-name").evaluate(node => getComputedStyle(node).animationPlayState), "paused");
    await page.getByRole("tab").first().click();
    assert.equal(await pane.evaluate(node => getComputedStyle(node, "::before").animationPlayState), "running");
  });
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

test("settings and save status identify OneDrive startup-only storage without claiming upload completion", async () => {
  await withPage(async page => {
    for (const isOneDrive of [true, false]) {
      const location = isOneDrive ? "C:\\OneDrive\\PromptTerminal\\workspace.json" : "C:\\Local\\PromptTerminal\\workspace.json";
      await page.evaluate(({ path, isOneDrive }) => window.__host.publish({ storage: { path, isOneDrive } }),
        { path: location, isOneDrive });
      assert.match(await page.locator("#save-status").getAttribute("title"),
        isOneDrive ? /OneDrive folder; changes load on app startup/ : /Local storage/);
      assert.ok((await page.locator("#save-status").getAttribute("title")).includes(location));
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const note = await page.locator("#dialog-body .form-note").allTextContents().then(notes =>
        notes.find(note => note.startsWith("Configuration file:")));
      assert.ok(note.includes(location));
      assert.match(note, isOneDrive ? /OneDrive storage: changes from other PCs load on app startup/ : /Local storage/);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });
});

test("automatic startup defaults on and settings changes do not start or arm current panes", async () => {
  const fixture = documentFixture();
  delete fixture.settings.autoStartAndArmOnStartup;
  await withPage(async page => {
    for (const enabled of [false, true]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const option = page.getByLabel("Automatically start all panes and arm schedules on app startup", { exact: true });
      assert.equal(await option.isChecked(), !enabled);
      assert.match(await page.locator("#dialog-body").innerText(), /without a review dialog/);
      await option.setChecked(enabled);
      await page.getByRole("button", { name: "Apply settings", exact: true }).click();
      assert.equal(await page.evaluate(() => window.__host.snapshot.document.settings.autoStartAndArmOnStartup), enabled);
    }
    assert.equal(await page.evaluate(() => window.__host.messages.some(message =>
      ["startPane", "startWorkspace", "armSchedule"].includes(message.type))), false);
  }, fixture);
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

test("new panes default to floating in a tiled-only workspace, and duplicates use the floating creation path", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    assert.equal(await page.getByLabel("Create as floating panel").isChecked(), true);
    await page.getByRole("button", { name: "Add unstarted pane", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "addPane").at(-1).data.floating), true);
    const pane = page.locator(`.pane[data-pane-id="${fixture.workspace.tabs[0].panes[0].id}"]`);
    await pane.locator("summary").click();
    await pane.getByRole("button", { name: "Duplicate as new pane", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "duplicatePane").length), 1);
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "splitPane").length), 0);
  });
});

test("viewport reports drive equal floating rows and columns without replacing terminals", async () => {
  const fixture = documentFixture(1, 6);
  const tab = fixture.workspace.tabs[0];
  tab.root = null;
  tab.floating = tab.panes.map((pane, index) => ({ paneId: pane.id, x: index * 100, y: 10, width: 600, height: 360, z: index + 1 }));
  await withPage(async page => {
    await page.evaluate(() => {
      window.__host.running();
      window.__floatingTerminals = Array.from(document.querySelectorAll(".pane"), pane =>
        [pane.dataset.paneId, pane.querySelector(".xterm")]);
      window.__host.responsiveFloating = true;
    });
    for (const [width, columns, rows] of [[1900, 3, 2], [1000, 2, 3]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(({ width, columns, rows }) => {
        const messages = window.__host.messages.filter(message => message.type === "workspaceViewport");
        const placements = window.__host.snapshot.document.workspace.tabs[0].floating;
        return messages.at(-1)?.data.browserWidth === width &&
          new Set(placements.map(item => item.x)).size === columns &&
          new Set(placements.map(item => item.y)).size === rows;
      }, { width, columns, rows });
      const actual = await page.locator(".pane.floating").evaluateAll(panes => panes.map(pane =>
        ({ x: pane.offsetLeft, y: pane.offsetTop, width: pane.offsetWidth, height: pane.offsetHeight })));
      assert.equal(new Set(actual.map(item => item.width)).size, 1);
      assert.equal(new Set(actual.map(item => item.height)).size, 1);
      for (let first = 0; first < actual.length; first++) for (let second = first + 1; second < actual.length; second++) {
        const a = actual[first], b = actual[second];
        assert.equal(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y, false);
      }
      assert.equal(await page.evaluate(() => window.__floatingTerminals.every(([id, terminal]) =>
        terminal === document.querySelector(`.pane[data-pane-id="${id}"] .xterm`))), true);
    }
    const header = await page.locator(".pane.floating .pane-header").first().boundingBox();
    await page.mouse.move(header.x + 3, header.y + 16);
    await page.mouse.down();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForFunction(() => window.__host.messages.filter(message => message.type === "workspaceViewport")
      .at(-1)?.data.browserWidth === 1400);
    await page.getByRole("button", { name: "Tab options", exact: true }).click();
    await page.getByLabel("Auto-arrange floating panes in an equal grid").uncheck();
    await page.getByRole("button", { name: "Save tab", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__host.snapshot.document.workspace.tabs[0].autoArrangeFloating), false);
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

test("hourly schedules use the hour boundary and do not require a local time or weekly day", async () => {
  await withPage(async (page, fixture) => {
    const id = fixture.workspace.tabs[0].panes[0].id;
    await page.locator(`[data-pane-id="${id}"] .pane-name`).click();
    assert.equal(await page.getByRole("button", { name: "Add and start pane", exact: true }).count(), 0);
    await page.getByLabel("Recurring task", { exact: true }).selectOption("hourly");
    assert.equal(await page.getByLabel("Recurring local time", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("Weekly day", { exact: true }).isDisabled(), true);
    await page.getByLabel("Startup command or multiline PowerShell script").fill("agent run 'Hourly review'");
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    const saved = await page.evaluate(() => window.__host.messages.filter(message => message.type === "editPane").at(-1).data.plan.recurrence);
    assert.deepEqual(saved, { frequency: "hourly", time: "00:00:00", day: "monday" });
    assert.equal(await page.evaluate(() => window.__host.messages.some(message => message.type === "armSchedule")), false);
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    assert.match(await page.locator("#dialog-body").innerText(), /Hourly on the hour \(local time\)/);
    await page.getByRole("button", { name: "Review and arm", exact: true }).click();
    await page.waitForFunction(() => window.__host.snapshot.schedules.length === 1);
    assert.match(await page.locator(`[data-pane-id="${id}"] .pane-schedule`).getAttribute("title"), /Hourly on the hour/);
    await page.getByRole("button", { name: "Disarm schedule", exact: true }).click();
    await page.getByRole("button", { name: "Configure", exact: true }).click();
    await page.getByLabel("Recurring task", { exact: true }).selectOption("daily");
    assert.equal(await page.getByLabel("Recurring local time", { exact: true }).isDisabled(), false);
  });
});

test("recurring panes default to auto-close and restore the interactive preference when recurrence is removed", async () => {
  await withPage(async page => {
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    const keepOpen = page.getByLabel("Keep shell open after startup script", { exact: true });
    const frequency = page.getByLabel("Recurring task", { exact: true });
    assert.equal(await keepOpen.isChecked(), true);
    assert.equal(await keepOpen.isDisabled(), false);
    for (const value of ["hourly", "daily", "weekdays", "weekly"]) {
      await frequency.selectOption(value);
      assert.equal(await keepOpen.isChecked(), false);
      assert.equal(await keepOpen.isDisabled(), true);
      await frequency.selectOption("");
      assert.equal(await keepOpen.isChecked(), true);
      assert.equal(await keepOpen.isDisabled(), false);
    }
    await keepOpen.uncheck();
    await frequency.selectOption("hourly");
    await frequency.selectOption("");
    assert.equal(await keepOpen.isChecked(), false);
    await page.getByRole("button", { name: "Add unstarted pane", exact: true }).click();
    const created = await page.evaluate(() => window.__host.messages.filter(message => message.type === "addPane").at(-1).data.pane);
    assert.equal(created.profile.keepShellOpen, false);
    assert.equal(created.plan.recurrence, null);
  });
});

test("legacy recurring keep-open profiles and copied profiles cannot leave an idle recurring shell", async () => {
  const fixture = documentFixture(1, 1);
  const definition = fixture.workspace.tabs[0].panes[0];
  definition.plan.recurrence = { frequency: "hourly", time: "00:00:00", day: "monday" };
  definition.profile.keepShellOpen = true;
  await withPage(async page => {
    await page.locator(`[data-pane-id="${definition.id}"] .pane-name`).click();
    const keepOpen = page.getByLabel("Keep shell open after startup script", { exact: true });
    assert.equal(await keepOpen.isChecked(), false);
    assert.equal(await keepOpen.isDisabled(), true);
    await page.getByLabel("Copy a saved launch profile", { exact: true }).selectOption(fixture.profiles[0].id);
    assert.equal(await keepOpen.isChecked(), false);
    assert.equal(await keepOpen.isDisabled(), true);
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    const saved = await page.evaluate(() => window.__host.messages.filter(message => message.type === "editPane").at(-1).data);
    assert.equal(saved.profile.keepShellOpen, false);
    assert.equal(saved.plan.recurrence.frequency, "hourly");
    assert.equal(await page.evaluate(() => window.__host.messages.some(message =>
      ["startPane", "armSchedule"].includes(message.type))), false);
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    await page.getByLabel("Recurring task", { exact: true }).selectOption("hourly");
    await page.getByLabel("Copy a saved launch profile", { exact: true }).selectOption(fixture.profiles[0].id);
    await page.getByRole("button", { name: "Add and start pane", exact: true }).click();
    const added = await page.evaluate(() => window.__host.messages.filter(message => message.type === "addStartedPane").at(-1).data.pane);
    assert.equal(added.profile.keepShellOpen, false);
    assert.equal(added.plan.recurrence.frequency, "hourly");
  }, fixture);
});

test("new-pane dialog offers a separate reviewed-start action and keeps unstarted creation as the default", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    const start = page.getByRole("button", { name: "Add and start pane", exact: true });
    assert.equal(await start.isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Add unstarted pane", exact: true }).isVisible(), true);
    await page.getByLabel("Pane name", { exact: true }).fill("Started agent");
    await page.getByLabel("Startup command or multiline PowerShell script").fill("agent run 'Start now'");
    await start.click();
    await page.waitForFunction(() => !document.querySelector("#app-dialog").open);
    const requests = await page.evaluate(() => window.__host.messages.filter(message =>
      ["addPane", "addStartedPane", "startPane", "armSchedule"].includes(message.type)));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, "addStartedPane");
    assert.equal(requests[0].data.tabId, fixture.workspace.activeTabId);
    assert.equal(requests[0].data.pane.name, "Started agent");
    assert.equal(requests[0].data.pane.profile.startupScript, "agent run 'Start now'");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Add and start pane", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    await page.getByLabel("Pane name", { exact: true }).press("Enter");
    await page.waitForFunction(() => window.__host.messages.some(message => message.type === "addPane"));
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "addStartedPane").length), 1);
  });
});

test("both pane submission buttons stay disabled while the reviewed-start request is pending", async () => {
  await withPage(async page => {
    await page.evaluate(() => {
      const original = window.chrome.webview.postMessage.bind(window.chrome.webview);
      window.chrome.webview.postMessage = message => {
        if (message.type !== "addStartedPane") return original(message);
        window.__host.messages.push(structuredClone(message));
        window.__pendingPaneStart = message;
      };
    });
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    await page.getByRole("button", { name: "Add and start pane", exact: true }).click();
    assert.equal(await page.locator("#dialog-submit").isDisabled(), true);
    assert.equal(await page.locator("#dialog-submit-start").isDisabled(), true);
    await page.evaluate(() => window.__host.emit({
      type: "result", id: window.__pendingPaneStart.id, ok: true, cancelled: true, error: null
    }));
    await page.waitForFunction(() => !document.querySelector("#dialog-submit-start").disabled);
    assert.equal(await page.locator("#app-dialog").evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator("#dialog-submit").isDisabled(), false);
    assert.equal(await page.evaluate(() => window.__host.messages.filter(message => message.type === "addStartedPane").length), 1);
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
