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
const targetExecutable = process.argv.slice(2).find(argument => argument !== "--features-only");
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
  return JSON.parse(await ps(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FeatureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
}
'@
$handle = (Get-Process -Id ${application.pid}).MainWindowHandle
${mode ? `[FeatureWindow]::ShowWindow($handle, ${mode === "maximize" ? 3 : 9}) | Out-Null` : ""}
${resize ? "if (-not [FeatureWindow]::MoveWindow($handle, 20, 20, 1120, 740, $true)) { throw 'Resize failed.' }" : ""}
Start-Sleep -Milliseconds 250
$rect = [FeatureWindow+Rect]::new()
if (-not [FeatureWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Window bounds could not be read.' }
@{ width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top;
   dpi = [FeatureWindow]::GetDpiForWindow($handle); maximized = [FeatureWindow]::IsZoomed($handle) } | ConvertTo-Json -Compress
`));
}

async function runAutomationFeatures(port) {
  const fixture = documentFixture(1, 2);
  const [scheduled, busy] = fixture.workspace.tabs[0].panes;
  scheduled.name = "Recurring smoke";
  busy.name = "Busy recurring smoke";
  scheduled.profile.startupScript = "[Console]::WriteLine('SCHEDULE-REVIEWED-RUN')";
  busy.profile.startupScript = "[Console]::WriteLine('BUSY-INTERACTIVE')";
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
  await page.waitForFunction(() => document.querySelectorAll(".pane.floating").length === 2);
  assert.equal(await page.locator(".pane.floating").count(), 2);

  await page.getByRole("button", { name: "Start pane Busy recurring smoke", exact: true }).click();
  await nativeButton("Start 1 session(s)", "Start reviewed sessions");
  await waitOutput(page, busy.id, "BUSY-INTERACTIVE");
  const busyPid = await processId(page, busy.id);
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
  await page.waitForSelector(`.pane[data-pane-id="${scheduled.id}"][data-state="exited"]`, { timeout: 75000 });
  await waitOutput(page, scheduled.id, "SCHEDULE-REVIEWED-RUN");
  assert.doesNotMatch(await page.locator(`[data-pane-id="${scheduled.id}"] .xterm-screen`).textContent(), /UNREVIEWED-MUST-NOT-RUN/);
  await page.waitForFunction(id => document.querySelector(`[data-pane-id="${id}"] .pane-schedule`)?.title.includes("Skipped: pane still has"), busy.id);
  assert.equal(await processId(page, busy.id), busyPid);
  console.log("PASS: real recurring task executes the reviewed snapshot, exits its shell, and skips a live pane without interruption");

  const normal = await windowGeometry("restore", true);
  await windowGeometry("maximize");
  await page.locator(".header-actions summary").click();
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#save-status").textContent === "Saved locally");
  const saved = JSON.parse(await fs.readFile(path.join(dataDirectory, "workspace.json"), "utf8"));
  const originalBounds = saved.workspace.tabs[0].floating.find(item => item.paneId === scheduled.id);
  const inherited = saved.workspace.tabs[0].floating.find(item => item.paneId !== scheduled.id);
  assert.equal(inherited.width, originalBounds.width);
  assert.equal(inherited.height, originalBounds.height);
  assert.equal(inherited.x, originalBounds.x + originalBounds.width + 12);
  assert.equal(inherited.y, originalBounds.y);
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
  if (process.argv.includes("--features-only")) {
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
