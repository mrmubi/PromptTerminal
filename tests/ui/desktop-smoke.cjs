const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { documentFixture } = require("./mock-host.cjs");

const execute = promisify(execFile);
const root = path.resolve(__dirname, "..", "..");
const targetExecutable = process.argv.slice(2).find(argument =>
  !["--features-only", "--recurring-defaults-only", "--floating-layout-only", "--activity-only", "--storage-only"].includes(argument));
const executable = targetExecutable ? path.resolve(targetExecutable)
  : path.join(root, "src", "PromptTerminal.App", "bin", "Debug", "net10.0-windows", "PromptTerminal.App.exe");
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const quote = value => `'${value.replaceAll("'", "''")}'`;
let application;
let browser;
let dataDirectory;
let currentPage;
const rendererErrors = [];

async function ps(script) {
  try {
    const { stdout } = await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-EncodedCommand",
      Buffer.from("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" + script, "utf16le").toString("base64")],
    { timeout: 30000, maxBuffer: 1048576 });
    return stdout.trim();
  } catch (error) {
    const detail = error.stderr?.match(/<S S="Error">([^<]+)/)?.[1]?.replaceAll("_x000D__x000A_", "\n");
    throw new Error((detail || error.stderr || (error.killed ? "Native automation exceeded 30 seconds." : error.message)) +
      (error.stdout ? "\n" + error.stdout.trim() : ""));
  }
}

async function assertBranding(page) {
  assert.equal(await page.title(), "Prompt Terminal");
  assert.match(await page.locator(".brand").innerText(), /^Prompt Terminal/);
  const native = JSON.parse(await ps(`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrandingWindow {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
function Measure-Icon([Drawing.Icon]$icon) {
  $bitmap = $icon.ToBitmap()
  try {
    $red = 0
    $white = 0
    for ($y = 0; $y -lt $bitmap.Height; $y++) {
      for ($x = 0; $x -lt $bitmap.Width; $x++) {
        $color = $bitmap.GetPixel($x, $y)
        if ($color.A -lt 128) { continue }
        if ($color.R -gt 120 -and $color.G -lt 100 -and $color.B -lt 100) { $red++ }
        if ($color.R -gt 220 -and $color.G -gt 220 -and $color.B -gt 220) { $white++ }
      }
    }
    return @{ red = $red / ($bitmap.Width * $bitmap.Height); white = $white / ($bitmap.Width * $bitmap.Height) }
  } finally { $bitmap.Dispose() }
}
$process = Get-Process -Id ${application.pid}
$handle = [BrandingWindow]::SendMessage($process.MainWindowHandle, 0x007F, [IntPtr]1, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero) { throw 'The main window has no application icon.' }
$windowIcon = [Drawing.Icon]::FromHandle($handle)
$fileIcon = [Drawing.Icon]::ExtractAssociatedIcon(${quote(executable)})
try {
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo(${quote(executable)})
  @{ title = $process.MainWindowTitle; description = $version.FileDescription; product = $version.ProductName;
     window = (Measure-Icon $windowIcon); executable = (Measure-Icon $fileIcon) } | ConvertTo-Json -Compress
} finally {
  $windowIcon.Dispose()
  $fileIcon.Dispose()
}
`));
  assert.equal(native.title, "Prompt Terminal");
  assert.equal(native.description, "Prompt Terminal");
  assert.equal(native.product, "Prompt Terminal");
  for (const [surface, colors] of Object.entries({ window: native.window, executable: native.executable })) {
    assert.ok(colors.red > .45, `${surface} icon has a red terminal background`);
    assert.ok(colors.white > .03, `${surface} icon has a white command prompt`);
  }
  console.log("PASS: spaced app title and red command-prompt icon in the header, native window and executable");
}

async function nativeButton(title, label) {
  await ps(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies @([Windows.Automation.InvokePattern].Assembly.Location, [Windows.Automation.AutomationPattern].Assembly.Location) -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class SmokeInvoke {
  public static volatile bool Running;
  public static Exception Error;
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  public static IntPtr Find(int processId, string title) {
    var found = IntPtr.Zero;
    EnumWindows((window, parameter) => {
      int owner; GetWindowThreadProcessId(window, out owner);
      if (owner != processId) return true;
      var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity);
      if (text.ToString() != title) return true;
      found = window; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static void Begin(InvokePattern pattern) {
    Running = true;
    var thread = new Thread(() => {
      try { pattern.Invoke(); } catch (Exception error) { Error = error; }
      finally { Running = false; }
    });
    thread.IsBackground = true;
    thread.SetApartmentState(ApartmentState.MTA);
    thread.Start();
  }
}
'@
for ($attempt = 0; $attempt -lt 200; $attempt++) {
  $handle = [SmokeInvoke]::Find(${application.pid}, ${quote(title)})
  if ($handle -ne [IntPtr]::Zero) {
    Write-Output 'Found native target window'
    $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
    $name = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, ${quote(label)})
    $type = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.AndCondition]::new($name, $type))
    if ($null -ne $button) {
      $pattern = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
      Write-Output 'Found native target button'
      [SmokeInvoke]::Begin($pattern)
      for ($delivery = 0; $delivery -lt 100; $delivery++) {
        if ($null -ne [SmokeInvoke]::Error) { throw [SmokeInvoke]::Error }
        if (-not [SmokeInvoke]::Running -or -not [SmokeInvoke]::IsWindow($handle) -or -not [SmokeInvoke]::IsWindowEnabled($handle)) { return }
        Start-Sleep -Milliseconds 50
      }
      throw 'Native action did not complete or open/close its dialog.'
    }
  }
  Start-Sleep -Milliseconds 100
}
throw ${quote(`Native button not found: ${title} / ${label}`)}
`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startApplication(port) {
  application = spawn(executable, ["--data-directory", dataDirectory], {
    cwd: root, stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }
  });
  application.on("error", error => { console.error(error.message); });
  return rendererPage(port);
}

async function rendererPage(port) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (application.exitCode !== null) throw new Error(`Desktop app exited before readiness: ${application.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch (error) {
      if (attempt === 149) throw new Error(`WebView2 did not become responsive: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page");
  page.on("pageerror", error => rendererErrors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.waitForURL("https://promptterminal.local/index.html");
  await page.waitForSelector(".workspace:not(.is-inactive) .pane");
  currentPage = page;
  return page;
}

async function waitOutput(page, paneId, text) {
  await page.waitForFunction(({ paneId, text }) =>
    document.querySelector(`.pane[data-pane-id="${paneId}"] .xterm-screen`)?.textContent.includes(text), { paneId, text });
}

async function processId(page, paneId) {
  const text = await page.locator(`.pane[data-pane-id="${paneId}"] .pane-state`).textContent();
  const match = /PID (\d+)/.exec(text);
  assert.ok(match, `A real process ID is visible: ${text}`);
  return Number(match[1]);
}

async function sendCommand(page, paneId, text) {
  await page.locator(`.pane[data-pane-id="${paneId}"] .xterm-helper-textarea`).focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function paneAction(page, paneId, label) {
  const pane = page.locator(`.pane[data-pane-id="${paneId}"]`);
  await pane.locator("summary").click();
  await pane.getByRole("button", { name: label, exact: true }).click();
}

async function renderedTranscript(page, paneId) {
  await page.evaluate(() => {
    window.__smokeOriginalPost = window.chrome.webview.postMessage;
    window.__smokeTranscript = null;
    window.chrome.webview.postMessage = function (message) {
      if (message.type === "transcript") window.__smokeTranscript = message.data.text;
      return window.__smokeOriginalPost.call(this, message);
    };
  });
  try {
    await paneAction(page, paneId, "Export transcript...");
    await nativeButton("Export terminal transcript", "Cancel");
    const text = await page.evaluate(() => window.__smokeTranscript);
    assert.equal(typeof text, "string");
    return text;
  } finally {
    await page.evaluate(() => { window.chrome.webview.postMessage = window.__smokeOriginalPost; });
  }
}

async function closeApplication() {
  if (!application || application.exitCode !== null) return;
  await ps(`
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SmokeWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
$process = Get-Process -Id ${application.pid}
[SmokeWindow]::PostMessage($process.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
`);
}

async function waitForExit() {
  if (application.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop application did not close cleanly.")), 15000);
    application.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function windowGeometry(mode = "", resize = false) {
  const bounds = resize === true ? { left: 20, top: 20, width: 1120, height: 740 } : resize;
  return JSON.parse(await ps(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FeatureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
}
'@
[FeatureWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$handle = (Get-Process -Id ${application.pid}).MainWindowHandle
${mode ? `[FeatureWindow]::ShowWindow($handle, ${mode === "maximize" ? 3 : 9}) | Out-Null` : ""}
${bounds ? `if (-not [FeatureWindow]::MoveWindow($handle, ${bounds.left}, ${bounds.top}, ${bounds.width}, ${bounds.height}, $true)) { throw 'Resize failed.' }` : ""}
Start-Sleep -Milliseconds 250
$rect = [FeatureWindow+Rect]::new()
if (-not [FeatureWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Window bounds could not be read.' }
$monitor = [FeatureWindow+MonitorInfo]::new()
$monitor.Size = [Runtime.InteropServices.Marshal]::SizeOf($monitor)
if (-not [FeatureWindow]::GetMonitorInfo([FeatureWindow]::MonitorFromWindow($handle, 2), [ref]$monitor)) { throw 'Monitor bounds could not be read.' }
@{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom;
   workLeft = $monitor.Work.Left; workTop = $monitor.Work.Top; workRight = $monitor.Work.Right; workBottom = $monitor.Work.Bottom;
   width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top;
   dpi = [FeatureWindow]::GetDpiForWindow($handle); maximized = [FeatureWindow]::IsZoomed($handle) } | ConvertTo-Json -Compress
`));
}

async function savedDocument(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const saved = JSON.parse(await fs.readFile(path.join(dataDirectory, "workspace.json"), "utf8"));
    if (predicate(saved)) return saved;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The expected workspace and window geometry were not persisted.");
}

async function assertFloatingGrid(page, count) {
  await page.waitForFunction(count => {
    const tab = window.__floatingState?.document.workspace.tabs[0];
    if (tab?.floating.length !== count || tab.root) return false;
    const section = document.querySelector(".workspace:not(.is-inactive)");
    const right = Math.max(...tab.floating.map(item => item.x + item.width));
    return right <= section.clientWidth - 10 && section.clientWidth - right <= count + 10;
  }, count);
  const grid = await page.evaluate(() => {
    const tab = window.__floatingState.document.workspace.tabs[0];
    return { placements: tab.floating, ids: tab.panes.map(pane => pane.id),
      rectangles: Array.from(document.querySelectorAll(".pane.floating"), pane =>
        ({ id: pane.dataset.paneId, x: pane.offsetLeft, y: pane.offsetTop, width: pane.offsetWidth, height: pane.offsetHeight })) };
  });
  assert.deepEqual(grid.placements.map(item => item.paneId), grid.ids);
  assert.equal(new Set(grid.placements.map(item => item.width)).size, 1);
  assert.equal(new Set(grid.placements.map(item => item.height)).size, 1);
  for (let index = 0; index < count; index++) {
    const item = grid.placements[index], actual = grid.rectangles.find(rect => rect.id === item.paneId);
    assert.deepEqual(actual, { id: item.paneId, x: item.x, y: item.y, width: item.width, height: item.height });
    assert.ok(item.width >= 280 && item.height >= 180);
    if (index) {
      const previous = grid.placements[index - 1];
      assert.ok(item.y > previous.y || item.y === previous.y && item.x > previous.x);
    }
    for (const other of grid.placements.slice(index + 1))
      assert.equal(item.x < other.x + other.width && item.x + item.width > other.x &&
        item.y < other.y + other.height && item.y + item.height > other.y, false);
  }
  return grid;
}

async function runFloatingLayout(port) {
  const fixture = documentFixture(1, 1), survivor = fixture.workspace.tabs[0].panes[0];
  survivor.name = "Layout survivor";
  survivor.profile.workingDirectory = root;
  survivor.profile.startupScript = "[Console]::WriteLine('LAYOUT-SURVIVOR'); " +
    "0..79 | ForEach-Object { [Console]::WriteLine(('LAYOUT-HISTORY-{0:D3}' -f $_)) }; " +
    "[Console]::WriteLine('LAYOUT-HISTORY-READY')";
  fixture.profiles[0].workingDirectory = root;
  await fs.writeFile(path.join(dataDirectory, "workspace.json"), JSON.stringify(fixture));
  let page = await startApplication(port);
  await page.evaluate(() => {
    window.__floatingViewportReports = 0;
    window.chrome.webview.addEventListener("message", event => {
      if (event.data.type === "state") window.__floatingState = event.data;
    });
    const originalPost = window.chrome.webview.postMessage;
    window.chrome.webview.postMessage = function (message) {
      if (message.type === "workspaceViewport") window.__floatingViewportReports++;
      return originalPost.call(this, message);
    };
  });
  const monitor = await windowGeometry(), scale = monitor.dpi / 96;
  const compact = { left: monitor.workLeft, top: monitor.workTop,
    width: Math.round(820 * scale), height: Math.min(monitor.workBottom - monitor.workTop, Math.round(760 * scale)) };
  const initial = await windowGeometry("restore", compact);
  await page.getByRole("button", { name: "Start pane Layout survivor", exact: true }).click();
  await nativeButton("Start 1 session(s)", "Start reviewed sessions");
  await waitOutput(page, survivor.id, "LAYOUT-HISTORY-READY");
  const baseline = await renderedTranscript(page, survivor.id);
  const visibleRows = await page.locator(`.pane[data-pane-id="${survivor.id}"] .xterm-rows > div`).count();
  assert.ok(visibleRows > 0);
  // ConPTY can redraw the live screen on resize; independently verify the older scrollback.
  const history = baseline.split(/\r?\n/).slice(0, -visibleRows).filter(line => /^LAYOUT-HISTORY-\d{3}$/.test(line));
  assert.ok(history.length >= 20);
  assert.match(baseline, /LAYOUT-SURVIVOR/, "The history marker starts in scrollback");
  const pid = await processId(page, survivor.id);
  const generation = await page.locator(`.pane[data-pane-id="${survivor.id}"]`).getAttribute("data-generation");
  await page.evaluate(id => { window.__survivorTerminal = document.querySelector(`[data-pane-id="${id}"] .xterm`); }, survivor.id);
  async function addPane(index) {
    await page.getByRole("button", { name: "+ Pane", exact: true }).click();
    assert.equal(await page.getByLabel("Create as floating panel").isChecked(), true);
    await page.getByLabel("Pane name", { exact: true }).fill(`Automatic floating ${index}`);
    await page.getByRole("button", { name: "Add unstarted pane", exact: true }).click();
    await page.waitForFunction(count => window.__floatingState?.document.workspace.tabs[0].panes.length === count, index);
    return assertFloatingGrid(page, index);
  }
  await addPane(2);
  const grown = await windowGeometry();
  if (initial.width < initial.workRight - initial.workLeft) assert.ok(grown.width > initial.width);
  assert.equal(grown.height, initial.height);
  assert.ok(grown.left >= grown.workLeft && grown.right <= grown.workRight);
  assert.equal(grown.maximized, false);
  console.log("PASS: new panes float by default, promote tiled panes, widen the native window and preserve height within the current monitor");
  await sendCommand(page, survivor.id, "[Console]::WriteLine('LAYOUT-FOCUSED-EARLIER')");
  await waitOutput(page, survivor.id, "LAYOUT-FOCUSED-EARLIER");
  await paneAction(page, survivor.id, "Duplicate as new pane");
  await assertFloatingGrid(page, 3);
  const capCount = Math.max(4, Math.ceil((monitor.workRight - monitor.workLeft) / scale / 600) + 2);
  for (let count = 4; count <= capCount; count++) await addPane(count);
  const wide = await windowGeometry();
  assert.equal(wide.width, wide.workRight - wide.workLeft);
  const wideGrid = await assertFloatingGrid(page, capCount);
  await windowGeometry("restore", compact);
  const narrowGrid = await assertFloatingGrid(page, capCount);
  assert.ok(narrowGrid.placements[0].width < wideGrid.placements[0].width ||
    narrowGrid.placements.at(-1).y > wideGrid.placements.at(-1).y);
  assert.equal((await windowGeometry()).width, initial.width, "Reflow does not undo a user's narrower window size");
  const reports = await page.evaluate(() => window.__floatingViewportReports);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__floatingViewportReports), reports, "Viewport reporting stabilizes without a resize loop");
  await windowGeometry("restore", { ...compact, width: wide.width });
  await assertFloatingGrid(page, capCount);
  const normal = await windowGeometry();
  await windowGeometry("maximize");
  await addPane(capCount + 1);
  assert.equal((await windowGeometry()).maximized, true, "Adding a pane never unmaximizes the window");
  const docked = await page.evaluate(() => window.__floatingState.document.workspace.tabs[0].panes.at(-1).id);
  await page.locator(`.pane[data-pane-id="${docked}"]`).getByRole("button", { name: /Float or dock/ }).click();
  await page.getByRole("button", { name: "Dock pane", exact: true }).click();
  await page.waitForFunction(() => {
    const tab = window.__floatingState.document.workspace.tabs[0];
    return tab.root && !tab.autoArrangeFloating;
  });
  await page.getByRole("button", { name: "Tab options", exact: true }).click();
  await page.getByLabel("Auto-arrange floating panes in an equal grid").check();
  await page.getByRole("button", { name: "Save tab", exact: true }).click();
  await assertFloatingGrid(page, capCount + 1);
  assert.equal(await processId(page, survivor.id), pid);
  assert.equal(await page.locator(`.pane[data-pane-id="${survivor.id}"]`).getAttribute("data-generation"), generation);
  assert.equal(await page.evaluate(id => window.__survivorTerminal ===
    document.querySelector(`[data-pane-id="${id}"] .xterm`), survivor.id), true);
  const transcript = await renderedTranscript(page, survivor.id);
  assert.match(transcript, /LAYOUT-SURVIVOR/);
  assert.deepEqual(transcript.split(/\r?\n/).filter(line => /^LAYOUT-HISTORY-\d{3}$/.test(line)).slice(0, history.length), history);
  console.log("PASS: creation-order grids, monitor cap, responsive rows/columns and maximized additions retain the real shell, generation, terminal and history");
  const saved = await savedDocument(document => document.mainWindow?.maximized &&
    document.workspace.tabs[0].floating.length === capCount + 1 &&
    Math.abs(document.mainWindow.width - normal.width / scale) < 3 &&
    Math.abs(document.mainWindow.height - normal.height / scale) < 3);
  assert.equal(saved.workspace.tabs[0].autoArrangeFloating, true);
  await closeApplication();
  await nativeButton("Close Prompt Terminal", "Close and stop");
  await waitForExit();
  await browser.close();
  browser = null;
  page = await startApplication(await freePort());
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), capCount + 1);
  assert.equal((await windowGeometry()).maximized, true);
  const restored = await windowGeometry("restore");
  assert.ok(Math.abs(restored.width - normal.width) < 4, "Automatic width growth restores as the normal window width");
  assert.ok(Math.abs(restored.height - normal.height) < 4, "The normal window height is retained");
  assert.doesNotMatch(await page.locator(".xterm-screen").allTextContents().then(text => text.join("")), /LAYOUT-SURVIVOR/);
  console.log("PASS: grid membership, normal window bounds and maximized state persist without restarting commands");
  await closeApplication();
  await waitForExit();
}

async function runActivityIndicator(port) {
  const fixture = documentFixture(1, 3), [working, idle, scheduled] = fixture.workspace.tabs[0].panes;
  working.name = "Output smoke";
  idle.name = "Idle smoke";
  scheduled.name = "Scheduled output smoke";
  for (const pane of [working, idle, scheduled]) {
    pane.profile.workingDirectory = root;
    pane.profile.enableIntegration = false;
  }
  idle.profile.enableIntegration = true;
  const due = new Date(Date.now() + 45000);
  scheduled.plan.recurrence = { frequency: "daily",
    time: [due.getHours(), due.getMinutes(), due.getSeconds()].map(value => String(value).padStart(2, "0")).join(":"), day: "monday" };
  scheduled.profile.startupScript = "0..3 | ForEach-Object { [Console]::WriteLine(('SCHEDULED-ACTIVITY-{0}' -f $_)); Start-Sleep -Seconds 1 }";
  fixture.profiles[0].workingDirectory = root;
  await fs.writeFile(path.join(dataDirectory, "workspace.json"), JSON.stringify(fixture));
  const page = await startApplication(port);
  await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
  await paneAction(page, scheduled.id, "Review and arm recurring task...");
  await nativeButton("Arm recurring task", "Arm reviewed schedule");
  for (const pane of [working, idle]) {
    await page.getByRole("button", { name: `Start pane ${pane.name}`, exact: true }).click();
    await nativeButton("Start 1 session(s)", "Start reviewed sessions");
  }
  await page.waitForFunction(() => document.querySelectorAll('.pane[data-state="running"]').length === 2);
  const workingPid = await processId(page, working.id), idlePid = await processId(page, idle.id);
  const pane = page.locator(`.pane[data-pane-id="${working.id}"]`);
  await page.waitForFunction(() => document.querySelectorAll(".pane.is-working").length === 0);
  assert.equal(await page.locator(".pane.is-working").count(), 0, "An idle live shell must not animate");
  await sendCommand(page, working.id,
    "0..3 | ForEach-Object { [Console]::WriteLine(('MANUAL-ACTIVITY-{0}' -f $_)); Start-Sleep -Seconds 1 }");
  for (let index = 0; index < 4; index++) {
    await waitOutput(page, working.id, `MANUAL-ACTIVITY-${index}`);
    assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), true);
    assert.equal(await pane.evaluate(node => getComputedStyle(node, "::before").animationName), "pane-border-orbit");
    assert.equal(await pane.locator(".pane-signal").textContent(), "");
    assert.equal(await page.locator(`.pane[data-pane-id="${idle.id}"]`).evaluate(node => node.classList.contains("is-working")), false);
  }
  await page.waitForFunction(id => !document.querySelector(`.pane[data-pane-id="${id}"]`).classList.contains("is-working"), working.id);
  assert.equal(await processId(page, working.id), workingPid, "Quiet output does not stop or complete a session");
  assert.equal(await processId(page, idle.id), idlePid);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sendCommand(page, working.id, "[Console]::WriteLine('REDUCED-MOTION-ACTIVITY')");
  await waitOutput(page, working.id, "REDUCED-MOTION-ACTIVITY");
  assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), true);
  assert.equal(await pane.evaluate(node => getComputedStyle(node, "::before").animationName), "none");
  assert.equal(await pane.locator(".pane-name").evaluate(node => getComputedStyle(node).opacity), "1");
  await sendCommand(page, working.id, "exit");
  await page.waitForSelector(`.pane[data-pane-id="${working.id}"][data-state="exited"]`);
  assert.equal(await pane.evaluate(node => node.classList.contains("is-working")), false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(id => document.querySelector(`.pane[data-pane-id="${id}"] .xterm-screen`)
    ?.textContent.includes("SCHEDULED-ACTIVITY-0"), scheduled.id, { timeout: 75000 });
  const scheduledPane = page.locator(`.pane[data-pane-id="${scheduled.id}"]`);
  assert.equal(await scheduledPane.evaluate(node => node.classList.contains("is-working")), true);
  assert.equal(await scheduledPane.locator(".pane-signal").textContent(), "");
  await page.waitForSelector(`.pane[data-pane-id="${scheduled.id}"][data-state="exited"]`);
  assert.equal(await scheduledPane.evaluate(node => node.classList.contains("is-working")), false);
  assert.equal(await processId(page, idle.id), idlePid);
  console.log("PASS: manual and scheduled output animate without integration; two-second inactivity, process exit and reduced motion are respected");
  const signaledPane = page.locator(`.pane[data-pane-id="${idle.id}"]`);
  for (const signal of ["working", "waiting", "completed", "working", "completed"]) {
    await sendCommand(page, idle.id, `Send-PromptTerminalSignal -State ${signal} -Message 'ACTIVITY-${signal}'`);
    await page.waitForFunction(({ id, signal }) =>
      document.querySelector(`.pane[data-pane-id="${id}"] .pane-signal`).textContent === `Integration: ${signal}`,
    { id: idle.id, signal });
    assert.equal(await signaledPane.evaluate(node => node.classList.contains("is-working")), signal !== "completed");
    await page.waitForTimeout(2300);
    assert.equal(await signaledPane.evaluate(node => node.classList.contains("is-working")), signal !== "completed",
      "Explicit working/waiting/completed states take precedence over output inactivity");
    if (signal === "completed") {
      await sendCommand(page, idle.id, "[Console]::WriteLine('AFTER-COMPLETED-OUTPUT')");
      await waitOutput(page, idle.id, "AFTER-COMPLETED-OUTPUT");
      assert.equal(await signaledPane.evaluate(node => node.classList.contains("is-working")), false);
    }
    assert.equal(await processId(page, idle.id), idlePid);
  }
  console.log("PASS: explicit working/waiting stay animated through silence; completed stops immediately and suppresses further output animation");
  await closeApplication();
  await nativeButton("Close Prompt Terminal", "Close and stop");
  await waitForExit();
}

async function runStorage(port) {
  const fixture = documentFixture(1, 1);
  fixture.workspace.tabs[0].panes[0].plan.recurrence =
    { frequency: "hourly", time: "00:00:00", day: "monday" };
  const configuration = path.join(dataDirectory, "workspace.json");
  await fs.writeFile(configuration, JSON.stringify(fixture));
  let page = await startApplication(port);
  assert.ok((await page.locator("#save-status").getAttribute("title")).includes(configuration));
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), 1);
  assert.equal(await page.getByText("Schedule not armed", { exact: true }).count(), 1);
  await fs.access(path.join(dataDirectory, "WebView2"));
  async function changeTheme(theme) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    await page.getByRole("button", { name: "Apply settings", exact: true }).click();
  }
  await changeTheme("light");
  let saved = await savedDocument(document => document.settings.theme === "light");
  saved.workspace.tabs[0].name = "Updated on another PC";
  await fs.writeFile(configuration, JSON.stringify(saved));
  await page.getByRole("button", { name: "Tab options", exact: true }).click();
  await page.getByLabel("Tab name", { exact: true }).fill("Unsaved local workspace");
  await page.getByRole("button", { name: "Save tab", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#save-status").textContent.includes("autosave paused"));
  assert.equal(JSON.parse(await fs.readFile(configuration, "utf8")).workspace.tabs[0].name, "Updated on another PC");
  await page.locator(".header-actions summary").click();
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await nativeButton("Replace externally changed workspace", "Retain original and save");
  saved = await savedDocument(document => document.workspace.tabs[0].name === "Unsaved local workspace");
  const recovered = (await fs.readdir(dataDirectory)).filter(name => /^workspace\.json\.recovered-.*\.json$/.test(name));
  assert.equal(recovered.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDirectory, recovered[0]), "utf8")).workspace.tabs[0].name,
    "Updated on another PC");
  saved.workspace.tabs[0].name = "Latest synced workspace";
  await fs.writeFile(configuration, JSON.stringify(saved));
  await changeTheme("dark");
  await page.waitForFunction(() => document.querySelector("#save-status").textContent.includes("autosave paused"));
  await closeApplication();
  await nativeButton("Close without saving workspace", "Close without saving");
  await waitForExit();
  await browser.close();
  browser = null;
  assert.equal(JSON.parse(await fs.readFile(configuration, "utf8")).workspace.tabs[0].name, "Latest synced workspace");
  page = await startApplication(await freePort());
  await page.getByRole("tab", { name: "Latest synced workspace", exact: true }).waitFor();
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), 1);
  assert.equal(await page.getByText("Schedule not armed", { exact: true }).count(), 1);
  await closeApplication();
  await waitForExit();
  console.log("PASS: explicit storage isolation, external-change protection, retained originals and startup-only reload without launching sessions or arming schedules");
}

async function runAutomationFeatures(port) {
  const fixture = documentFixture(1, 2);
  const [scheduled, busy] = fixture.workspace.tabs[0].panes;
  scheduled.name = "Recurring smoke";
  busy.name = "Busy recurring smoke";
  scheduled.profile.startupScript = "Get-ChildItem; [Console]::WriteLine('SCHEDULE-REVIEWED-RUN')";
  scheduled.profile.resumeScript = "[Console]::WriteLine('RECURRING-RESUME-EXIT')";
  busy.profile.startupScript = "[Console]::WriteLine('BUSY-COMMAND-RUNNING'); Start-Sleep -Seconds 600";
  for (const pane of [scheduled, busy]) {
    pane.profile.workingDirectory = root;
    pane.plan.recurrence = { frequency: "daily", time: "09:00:00", day: "monday" };
  }
  fixture.profiles[0].workingDirectory = root;
  await fs.writeFile(path.join(dataDirectory, "workspace.json"), JSON.stringify(fixture));
  let page = await startApplication(port);
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), 2);
  assert.equal(await page.getByText("Schedule not armed", { exact: true }).count(), 2);

  for (const enabled of [true, false, true]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Prevent automatic sleep / hibernation while app is open").setChecked(enabled);
    await page.getByRole("button", { name: "Apply settings", exact: true }).click();
    await page.waitForFunction(text => document.querySelector("#power-status").textContent === text,
      enabled ? "Keep-awake on" : "Sleep allowed");
  }
  console.log("PASS: native keep-awake can be enabled and disabled without administrator or system power changes");

  await page.locator(`[data-pane-id="${scheduled.id}"]`).getByRole("button", { name: /Float or dock/ }).click();
  await page.getByRole("button", { name: "+ Pane", exact: true }).click();
  assert.equal(await page.getByLabel("Create as floating panel").isChecked(), true);
  await page.getByLabel("Pane name", { exact: true }).fill("Inherited floating smoke");
  await page.getByRole("button", { name: "Add unstarted pane", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".pane.floating").length === 3);
  assert.equal(await page.locator(".pane.floating").count(), 3);

  for (const action of ["start", "restart", "resume"]) {
    const generation = Number(await page.locator(`.pane[data-pane-id="${scheduled.id}"]`).getAttribute("data-generation"));
    if (action === "start")
      await page.getByRole("button", { name: "Start pane Recurring smoke", exact: true }).click();
    else await paneAction(page, scheduled.id, action === "restart" ? "Restart with new process..." : "Run configured resume command...");
    await nativeButton("Start 1 session(s)", "Start reviewed sessions");
    await page.waitForFunction(({ id, generation }) => {
      const pane = document.querySelector(`.pane[data-pane-id="${id}"]`);
      return pane?.dataset.state === "exited" && Number(pane.dataset.generation) > generation;
    }, { id: scheduled.id, generation });
    await waitOutput(page, scheduled.id, action === "resume" ? "RECURRING-RESUME-EXIT" : "SCHEDULE-REVIEWED-RUN");
    assert.match(await page.locator(`[data-pane-id="${scheduled.id}"] .pane-state`).innerText(), /\(0\)/);
    assert.equal(await page.locator(`[data-pane-id="${scheduled.id}"] .pane-schedule`).innerText(), "Schedule not armed");
  }
  await page.getByRole("button", { name: "Start workspace", exact: true }).click();
  await nativeButton("Start 3 session(s)", "Start reviewed sessions");
  await page.waitForSelector(`.pane[data-pane-id="${scheduled.id}"][data-state="exited"]`);
  await waitOutput(page, scheduled.id, "SCHEDULE-REVIEWED-RUN");
  await waitOutput(page, busy.id, "BUSY-COMMAND-RUNNING");
  const busyPid = await processId(page, busy.id);
  const interactive = page.getByRole("region", { name: "Inherited floating smoke pane", exact: true });
  const interactiveId = await interactive.getAttribute("data-pane-id");
  await page.waitForSelector(`.pane[data-pane-id="${interactiveId}"][data-state="running"]`);
  const interactivePid = await processId(page, interactiveId);
  console.log("PASS: recurring manual Start/Restart/Resume/workspace launches close after their commands; ordinary prompts remain open");
  const paneCount = await page.locator(".pane").count();
  await page.getByRole("button", { name: "+ Pane", exact: true }).click();
  await page.getByLabel("Pane name", { exact: true }).fill("Started pane smoke");
  await page.getByLabel("Startup command or multiline PowerShell script").fill("[Console]::WriteLine('CREATED-AND-STARTED')");
  await page.getByLabel("Recurring task", { exact: true }).selectOption("hourly");
  assert.equal(await page.getByLabel("Recurring local time", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Keep shell open after startup script", { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel("Keep shell open after startup script", { exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Add and start pane", exact: true }).click();
  await nativeButton("Add and start pane", "Cancel");
  await page.waitForFunction(() => !document.querySelector("#dialog-submit-start").disabled);
  assert.equal(await page.locator(".pane").count(), paneCount, "Canceling review creates no pane");
  assert.equal(await page.locator("#app-dialog").evaluate(dialog => dialog.open), true);
  await page.getByLabel("PowerShell executable", { exact: true }).fill(path.join(dataDirectory, "missing", "pwsh.exe"));
  await page.getByRole("button", { name: "Add and start pane", exact: true }).click();
  await page.waitForSelector("#dialog-error:not([hidden])");
  assert.match(await page.locator("#dialog-error").innerText(), /not added or started.*not found/i);
  assert.equal(await page.locator(".pane").count(), paneCount, "Invalid launches create no pane");
  await page.getByLabel("PowerShell executable", { exact: true }).fill(fixture.profiles[0].executable);
  await page.getByRole("button", { name: "Add and start pane", exact: true }).click();
  await nativeButton("Add and start pane", "Add and start reviewed pane");
  await page.waitForFunction(count => !document.querySelector("#app-dialog").open &&
    document.querySelectorAll(".pane").length === count, paneCount + 1);
  const createdPane = page.getByRole("region", { name: "Started pane smoke pane", exact: true });
  const createdId = await createdPane.getAttribute("data-pane-id");
  await waitOutput(page, createdId, "CREATED-AND-STARTED");
  await page.waitForSelector(`.pane[data-pane-id="${createdId}"][data-state="exited"]`);
  assert.match(await createdPane.locator(".pane-state").innerText(), /\(0\)/);
  assert.notEqual(await processId(page, createdId), busyPid);
  assert.equal(await processId(page, busy.id), busyPid, "Only the new pane starts");
  assert.equal(await createdPane.locator(".pane-schedule").innerText(), "Schedule not armed");
  await page.evaluate(() => {
    window.__hourlySchedule = null;
    window.chrome.webview.addEventListener("message", event => {
      if (event.data.type === "state")
        window.__hourlySchedule = event.data.schedules?.find(item => item.recurrence.frequency === "hourly") || null;
    });
  });
  await paneAction(page, createdId, "Review and arm recurring task...");
  await nativeButton("Arm recurring task", "Arm reviewed schedule");
  await page.waitForFunction(() => window.__hourlySchedule !== null);
  const hourly = await page.evaluate(() => window.__hourlySchedule);
  const nextHour = new Date(hourly.nextRun);
  assert.equal(hourly.paneId, createdId);
  assert.equal(nextHour.getMinutes(), 0);
  assert.equal(nextHour.getSeconds(), 0);
  assert.ok(nextHour.getTime() > Date.now() && nextHour.getTime() <= Date.now() + 3600000);
  await paneAction(page, createdId, "Disarm recurring task");
  await page.waitForFunction(() => window.__hourlySchedule === null);
  await createdPane.getByRole("button", { name: "Close pane Started pane smoke", exact: true }).click();
  await createdPane.waitFor({ state: "detached" });
  assert.equal(await page.locator(".pane").count(), paneCount);
  console.log("PASS: add-and-start requires review, cancellation/invalid input create no pane, and hourly arming targets the next local :00");
  const scheduledGeneration = Number(await page.locator(`.pane[data-pane-id="${scheduled.id}"]`).getAttribute("data-generation"));
  const due = new Date(Date.now() + 35000);
  const time = [due.getHours(), due.getMinutes(), due.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
  for (const pane of [scheduled, busy]) {
    await paneAction(page, pane.id, "Edit launch configuration...");
    await page.getByLabel("Recurring local time", { exact: true }).fill(time);
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await paneAction(page, pane.id, "Review and arm recurring task...");
    await nativeButton("Arm recurring task", "Arm reviewed schedule");
  }
  await paneAction(page, scheduled.id, "Edit launch configuration...");
  await page.getByLabel("Startup command or multiline PowerShell script").fill("[Console]::WriteLine('UNREVIEWED-MUST-NOT-RUN')");
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page.waitForFunction(({ id, generation }) => {
    const pane = document.querySelector(`.pane[data-pane-id="${id}"]`);
    return pane?.dataset.state === "exited" && Number(pane.dataset.generation) > generation;
  }, { id: scheduled.id, generation: scheduledGeneration }, { timeout: 75000 });
  await waitOutput(page, scheduled.id, "SCHEDULE-REVIEWED-RUN");
  assert.doesNotMatch(await page.locator(`[data-pane-id="${scheduled.id}"] .xterm-screen`).textContent(), /UNREVIEWED-MUST-NOT-RUN/);
  await page.waitForFunction(id => document.querySelector(`[data-pane-id="${id}"] .pane-schedule`)?.title.includes("Skipped: pane still has"), busy.id);
  assert.equal(await processId(page, busy.id), busyPid);
  assert.equal(await processId(page, interactiveId), interactivePid);
  console.log("PASS: real recurring task executes the reviewed snapshot, exits its shell, and skips a live pane without interruption");
  if (process.argv.includes("--recurring-defaults-only")) {
    await closeApplication();
    await nativeButton("Close Prompt Terminal", "Close and stop");
    await waitForExit();
    return;
  }

  const normal = await windowGeometry("restore", true);
  await windowGeometry("maximize");
  await page.locator(".header-actions summary").click();
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  const saved = await savedDocument(document => document.mainWindow?.maximized &&
    Math.abs(document.mainWindow.width - normal.width * 96 / normal.dpi) < 3 &&
    Math.abs(document.mainWindow.height - normal.height * 96 / normal.dpi) < 3);
  const originalBounds = saved.workspace.tabs[0].floating.find(item => item.paneId === scheduled.id);
  const inherited = saved.workspace.tabs[0].floating.find(item => item.paneId === interactiveId);
  const previous = saved.workspace.tabs[0].floating.find(item => item.paneId === busy.id);
  assert.equal(inherited.width, originalBounds.width);
  assert.equal(inherited.height, originalBounds.height);
  assert.ok(inherited.y > previous.y ||
    inherited.y === previous.y && inherited.x === previous.x + previous.width + 12);
  assert.ok(Math.abs(saved.mainWindow.width - normal.width * 96 / normal.dpi) < 3);
  assert.ok(Math.abs(saved.mainWindow.height - normal.height * 96 / normal.dpi) < 3);
  assert.equal(saved.mainWindow.maximized, true);
  assert.equal(saved.settings.preventSleep, true);
  assert.equal(JSON.stringify(saved).includes("nextRun"), false);
  await closeApplication();
  await nativeButton("Close Prompt Terminal", "Close and stop");
  await waitForExit();

  page = await startApplication(port);
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), 3);
  assert.equal(await page.getByText("Schedule not armed", { exact: true }).count(), 2);
  assert.equal(await page.locator("#power-status").innerText(), "Keep-awake on");
  assert.equal((await windowGeometry()).maximized, true);
  const restored = await windowGeometry("restore");
  assert.ok(Math.abs(restored.width - normal.width) < 4, "Normal window width is restored after maximization");
  assert.ok(Math.abs(restored.height - normal.height) < 4, "Normal window height is restored after maximization");
  console.log("PASS: inherited floating placement, power preference and normal/maximized window size persist; schedules never auto-arm on reopen");
  await closeApplication();
  await waitForExit();
}

async function run() {
  await fs.access(executable);
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "PromptTerminal-smoke-"));
  if (process.argv.includes("--storage-only")) {
    await runStorage(await freePort());
    assert.deepEqual(rendererErrors, []);
    return;
  }
  if (process.argv.includes("--activity-only")) {
    await runActivityIndicator(await freePort());
    assert.deepEqual(rendererErrors, []);
    return;
  }
  if (process.argv.includes("--floating-layout-only")) {
    await runFloatingLayout(await freePort());
    assert.deepEqual(rendererErrors, []);
    return;
  }
  if (process.argv.includes("--features-only") || process.argv.includes("--recurring-defaults-only")) {
    await runAutomationFeatures(await freePort());
    assert.deepEqual(rendererErrors, []);
    return;
  }
  const fixture = documentFixture(3, 4);
  const initialPaneCount = fixture.workspace.tabs.flatMap(tab => tab.panes).length;
  fixture.settings.theme = "dark";
  for (const profile of fixture.profiles) profile.workingDirectory = root;
  for (const tab of fixture.workspace.tabs) for (const pane of tab.panes) {
    pane.profile.workingDirectory = root;
    pane.profile.startupScript = `[Console]::WriteLine('SMOKE:${pane.id}'); [Console]::WriteLine('UNICODE: \u03bb \u4e2d')`;
    pane.profile.keepShellOpen = true;
  }
  await fs.writeFile(path.join(dataDirectory, "workspace.json"), JSON.stringify(fixture));
  const port = await freePort();
  let page = await startApplication(port);
  await assertBranding(page);
  const first = fixture.workspace.tabs[0].panes[0].id;
  const sibling = fixture.workspace.tabs[0].panes[1].id;
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), initialPaneCount, "Restoring never launches scripts");
  await page.evaluate(() => {
    window.__smokeActions = [];
    document.addEventListener("click", event => window.__smokeActions.push(event.target.closest("[data-action]")?.dataset.action || event.target.tagName), true);
    window.__smokeResponses = [];
    window.chrome.webview.addEventListener("message", event => window.__smokeResponses.push({ type: event.data.type, error: event.data.error }));
  });

  await page.getByRole("button", { name: "Start workspace", exact: true }).click();
  await page.waitForFunction(() => window.__smokeActions.includes("startWorkspace"));
  await nativeButton("Start 4 session(s)", "Start reviewed sessions");
  await page.waitForSelector(`.pane[data-pane-id="${first}"][data-state="running"]`);
  await page.waitForSelector(`.pane[data-pane-id="${sibling}"][data-state="running"]`);
  await waitOutput(page, first, `SMOKE:${first}`);
  await waitOutput(page, first, "UNICODE: \u03bb \u4e2d");
  const originalPid = await processId(page, first);
  const siblingPid = await processId(page, sibling);
  assert.notEqual(originalPid, siblingPid);
  await sendCommand(page, first, "[Console]::WriteLine(('INPUT-' + (40+2)))");
  await waitOutput(page, first, "INPUT-42");
  assert.equal(await page.locator(`.pane[data-pane-id="${sibling}"] .xterm-screen`).textContent().then(text => text.includes("INPUT-42")), false);
  console.log("PASS: real independent PowerShell processes, Unicode output and focused interactive input");

  await page.evaluate(id => { window.__terminalBefore = document.querySelector(`.pane[data-pane-id="${id}"] .xterm`); }, first);
  await page.locator(`.pane[data-pane-id="${first}"]`).getByRole("button", { name: /Float or dock/ }).click();
  await page.waitForSelector(`.pane.floating[data-pane-id="${first}"]`);
  await page.locator(`.pane[data-pane-id="${first}"]`).getByRole("button", { name: /Maximize or restore/ }).click();
  await page.waitForSelector(".pane.is-masked", { state: "attached" });
  await page.locator(`.pane[data-pane-id="${first}"]`).getByRole("button", { name: /Maximize or restore/ }).click();
  await paneAction(page, first, "Move to another tab...");
  await page.getByLabel("Destination tab", { exact: true }).selectOption(fixture.workspace.tabs[1].id);
  await page.getByRole("button", { name: "Move pane", exact: true }).click();
  await page.waitForSelector(`.workspace:not(.is-inactive) .pane[data-pane-id="${first}"]`);
  assert.equal(await processId(page, first), originalPid);
  assert.equal(await page.evaluate(id => window.__terminalBefore === document.querySelector(`.pane[data-pane-id="${id}"] .xterm`), first), true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "Apply settings", exact: true }).click();
  await page.waitForSelector("html[data-theme='light']");
  assert.equal(await processId(page, first), originalPid);
  await waitOutput(page, first, "INPUT-42");
  console.log("PASS: live float/maximize/cross-tab move/theme switch preserve process and terminal history");

  const unicodePayload = "A\u03bb\u4e2d".repeat(5);
  await sendCommand(page, first, `0..7999 | ForEach-Object { [Console]::WriteLine(('{0:D4}|${unicodePayload}|END' -f $_)) }; [Console]::WriteLine(('UNICODE-LARGE-' + 'DONE'))`);
  await waitOutput(page, first, "UNICODE-LARGE-DONE");
  const rendered = await renderedTranscript(page, first);
  const unicodeLines = rendered.split(/\r?\n/).filter(line => /^\d{4}\|A\u03bb\u4e2d/.test(line));
  const numberedSamples = rendered.split(/\r?\n/).filter(line => /^\d/.test(line)).slice(0, 3).map(line => line.slice(0, 70));
  assert.equal(unicodeLines.length, 8000, `No rendered Unicode lines were dropped or duplicated; buffer characters=${rendered.length}, numbered samples=${JSON.stringify(numberedSamples)}`);
  for (let index = 0; index < unicodeLines.length; index++)
    assert.equal(unicodeLines[index], `${String(index).padStart(4, "0")}|${unicodePayload}|END`, `Rendered Unicode line ${index}`);
  console.log("PASS: all 8,000 Unicode output lines render exactly once and in order under backpressure");

  await page.getByRole("button", { name: "Start workspace", exact: true }).click();
  await nativeButton("Start 4 session(s)", "Start reviewed sessions");
  await page.locator(`.tab[data-tab-id="${fixture.workspace.tabs[2].id}"]`).click();
  await page.getByRole("button", { name: "Start workspace", exact: true }).click();
  await nativeButton("Start 4 session(s)", "Start reviewed sessions");
  await page.waitForFunction(count => document.querySelectorAll(".pane[data-state='running']").length === count, initialPaneCount);
  await page.locator(`.tab[data-tab-id="${fixture.workspace.tabs[1].id}"]`).click();
  const allPids = await page.locator(".pane-state").evaluateAll(nodes => nodes.map(node => Number(/PID (\d+)/.exec(node.textContent)?.[1])));
  assert.equal(new Set(allPids).size, initialPaneCount);
  console.log("PASS: three tabs with twelve real, independent live PowerShell processes");
  const generation = Number(await page.locator(`.pane[data-pane-id="${first}"]`).getAttribute("data-generation"));
  await paneAction(page, first, "Restart with new process...");
  await nativeButton("Restart session", "Stop and restart");
  await nativeButton("Start 1 session(s)", "Start reviewed sessions");
  await page.waitForFunction(({ first, generation }) => {
    const pane = document.querySelector(`.pane[data-pane-id="${first}"]`);
    return pane?.dataset.state === "running" && Number(pane.dataset.generation) > generation;
  }, { first, generation });
  assert.notEqual(await processId(page, first), originalPid);
  assert.equal(await processId(page, sibling), siblingPid);
  await page.evaluate(({ first, generation, id }) => window.chrome.webview.postMessage({
    version: 1, id, type: "input", paneId: first, generation, data: { text: "[Console]::WriteLine('STALE-INPUT-MUST-NOT-RUN')\r" }
  }), { first, generation, id: randomUUID() });
  await page.waitForSelector(".notice.error");
  assert.match(await page.locator(".notice.error").last().innerText(), /Stale input\/output messages were rejected/);
  assert.equal(await page.locator(`.pane[data-pane-id="${first}"] .xterm-screen`).textContent().then(text => text.includes("STALE-INPUT-MUST-NOT-RUN")), false);
  console.log("PASS: restart changes only its own process and rejects delayed old-generation input");

  await page.getByRole("button", { name: "+ Pane", exact: true }).click();
  await page.getByLabel("Pane name", { exact: true }).fill("Dependent test");
  await page.getByLabel("Startup command or multiline PowerShell script").fill("[Console]::WriteLine('DEPENDENT-LAUNCHED')");
  await page.getByLabel("Wait for explicit completed signal from").selectOption(first);
  await page.getByRole("button", { name: "Add unstarted pane", exact: true }).click();
  await page.getByRole("button", { name: "Start pane Dependent test", exact: true }).click();
  await nativeButton("Start 1 session(s)", "Start reviewed sessions");
  await page.waitForSelector(".pane[data-state='queued']");
  const dependent = await page.locator(".pane[data-state='queued']").getAttribute("data-pane-id");
  await sendCommand(page, first, "Send-PromptTerminalSignal -State completed -Message 'Parent done'");
  await page.waitForSelector(`.pane[data-pane-id="${dependent}"][data-state="running"]`);
  await waitOutput(page, dependent, "DEPENDENT-LAUNCHED");
  console.log("PASS: dependent startup waits for an explicit integration signal");

  const survivingPid = await processId(page, first);
  await page.evaluate(id => window.chrome.webview.postMessage({
    version: 1, id, type: "rendererError", paneId: null, generation: null, data: { text: "Smoke-test renderer recovery" }
  }), randomUUID());
  await nativeButton("Prompt Terminal", "Reload terminal views");
  await nativeButton("Recreate terminal views", "Reload views");
  await page.waitForSelector(".workspace:not(.is-inactive) .pane[data-state='running']");
  assert.equal(await processId(page, first), survivingPid);
  await sendCommand(page, first, "[Console]::WriteLine(('RECOVERY-' + (40+2)))");
  await waitOutput(page, first, "RECOVERY-42");
  console.log("PASS: explicit renderer recovery keeps processes alive and resumes interactive output");

  const debugSession = await browser.newBrowserCDPSession();
  const processes = await debugSession.send("SystemInfo.getProcessInfo");
  const browserProcess = processes.processInfo.find(process => process.type === "browser");
  assert.ok(browserProcess && Number.isInteger(Number(browserProcess.id)) && Number(browserProcess.id) > 0);
  await ps(`Stop-Process -Id ${Number(browserProcess.id)} -Force -ErrorAction Stop`);
  await nativeButton("Prompt Terminal", "Reload terminal views");
  await nativeButton("Recreate terminal views", "Reload views");
  page = await rendererPage(port);
  assert.equal(await processId(page, first), survivingPid);
  await sendCommand(page, first, "[Console]::WriteLine(('BROWSER-RECOVERY-' + (40+2)))");
  await waitOutput(page, first, "BROWSER-RECOVERY-42");
  console.log("PASS: actual WebView2 browser-process loss recreates the control without restarting shells");

  await page.locator(".header-actions summary").click();
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#save-status").textContent === "Saved locally");
  const saved = JSON.parse(await fs.readFile(path.join(dataDirectory, "workspace.json"), "utf8"));
  assert.equal(saved.settings.theme, "light");
  assert.equal(saved.workspace.tabs.flatMap(tab => tab.panes).length, initialPaneCount + 1);
  assert.equal(JSON.stringify(saved).includes("processId"), false);
  await closeApplication();
  await nativeButton("Close Prompt Terminal", "Close and stop");
  await waitForExit();
  assert.equal(application.exitCode, 0);
  console.log("PASS: atomic persistence excludes runtime identities and confirmed shutdown succeeds");

  page = await startApplication(port);
  await page.waitForSelector(".workspace:not(.is-inactive) .pane");
  assert.equal(await page.locator(".pane[data-state='notStarted']").count(), initialPaneCount + 1);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  console.log("PASS: relaunch restores theme and layout without executing any saved scripts");
  const invalid = fixture.workspace.tabs[1].panes[0].id;
  await paneAction(page, invalid, "Edit launch configuration...");
  await page.getByLabel("PowerShell executable", { exact: true }).fill(path.join(dataDirectory, "missing", "pwsh.exe"));
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page.getByRole("button", { name: "Start workspace", exact: true }).click();
  await nativeButton("Start 6 session(s)", "Start reviewed sessions");
  await page.waitForSelector(`.pane[data-pane-id="${invalid}"][data-state="failed"]`);
  assert.match(await page.locator(`.pane[data-pane-id="${invalid}"] .empty-cover`).innerText(), /not found/);
  await page.waitForSelector(`.pane[data-pane-id="${first}"][data-state="running"]`);
  await sendCommand(page, first, "Send-PromptTerminalSignal -State completed -Message 'Parent done again'");
  await page.waitForFunction(() => document.querySelectorAll(".pane[data-state='running']").length === 5);
  console.log("PASS: an invalid pane fails visibly without preventing valid sibling launches");
  await closeApplication();
  await nativeButton("Close Prompt Terminal", "Close and stop");
  await waitForExit();
  await runAutomationFeatures(port);
  assert.deepEqual(rendererErrors, []);
}

run().catch(async error => {
  console.error(error.stack);
  process.exitCode = 1;
  if (currentPage && !currentPage.isClosed()) {
    const text = await currentPage.locator("#notices").innerText();
    if (text) console.error("Desktop notices:", text);
    console.error("Desktop event diagnostics:", await currentPage.evaluate(() => ({
      actions: window.__smokeActions?.slice(-10), responses: window.__smokeResponses?.slice(-10), visibility: document.visibilityState,
      states: Array.from(document.querySelectorAll(".pane-state"), node => node.textContent)
    })));
  }
}).finally(async () => {
  if (application && application.exitCode === null) {
    try { await ps(`Stop-Process -Id ${application.pid} -Force -ErrorAction Stop`); }
    catch (error) { console.error("Desktop cleanup failed:", error.message); process.exitCode = 1; }
  }
  if (browser?.isConnected()) await browser.close();
  if (dataDirectory) {
    assert.equal(path.dirname(dataDirectory), os.tmpdir());
    assert.ok(path.basename(dataDirectory).startsWith("PromptTerminal-smoke-"));
    await fs.rm(dataDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
