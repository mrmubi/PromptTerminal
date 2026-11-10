# Prompt Terminal

A Windows desktop workspace for independent PowerShell sessions and interactive
agent CLIs. The application is C#/.NET 10 with WPF, Windows ConPTY, and one local
WebView2/xterm.js rendering surface. No agent-provider API or cloud account is
required by the application.

## Build and run

Requirements:

- Windows 11 x64 and a .NET 10 SDK compatible with [global.json](global.json).
- Microsoft Edge WebView2 Evergreen Runtime.
- Node.js 20+ for bundling and testing the renderer, not for running a published app.
- PowerShell 7 is recommended. Windows PowerShell 5.1 can be selected explicitly.
- Git is optional, for the worktree helper.

From the project directory in PowerShell:

```powershell
npm ci
dotnet build .\PromptTerminal.sln
dotnet run --project .\src\PromptTerminal.App\PromptTerminal.App.csproj --no-build
```

`npm ci` bundles the pinned xterm packages and their licenses locally. If
dependencies are already installed, `npm run vendor` refreshes those assets.
The build reports missing assets rather than producing an incomplete application.

The app uses an original red command-prompt-style icon in the executable, window
and header. Its SVG source is bundled with the renderer; `npm run icon` regenerates
the multi-resolution Windows icon using the installed Microsoft Edge browser.
Executable names and the existing configuration directory remain `PromptTerminal`
for compatibility.

Create a tab or pane, edit its shell, working directory and startup command, then
choose **Review and start** or **Start workspace**. The native preview shows the
resolved executable, scripts, environment overrides and launch conditions.
Restoring or importing a workspace **never starts its sessions automatically**.

PowerShell 7 is selected for a new configuration when available; otherwise the
default profile explicitly names Windows PowerShell. A configured executable is
never silently replaced by another shell.

## Included features

- Named, colored, reorderable tabs; duplicate tabs with new pane identities.
- Tiled splits with pointer/keyboard splitters, floating panels, dragging,
  resizing, docking previews, maximize/restore and cross-tab pane moves.
  Existing sessions and terminal instances survive layout changes.
- Per-pane launch profiles, multiline startup/resume scripts, environment
  overrides, profile loading and keep-open settings.
- Start, Ctrl+C interrupt, confirmed restart/stop/close, read-only monitoring,
  terminal search, copy/paste and opt-in plain-text transcript export.
- Dark, White/Light and Follow Windows themes; live font/scrollback settings and
  configurable shortcuts.
- Atomic local autosave with a last-save backup, explicit recovery, safe layout
  import and script-free export by default.
- Workspace templates, prompt snippets, command palette, Git worktree creation,
  explicit integration notifications, scheduled/dependent startup, deliberate
  broadcast input and shell-host CPU/memory indicators.

Floating title bars are clamped to reachable positions after a viewport change.
Large tiled layouts scroll rather than shrinking terminals below usable bounds.
For keyboard-only floating layout changes, edit Left/Top/Width/Height in pane
configuration. Use **Tab options** to rename, color, reorder or duplicate a tab.
Alt+drag a floating title bar over a tiled pane to preview docking, or use its
**Dock with placement preview** action.

Launch/profile/plan edits apply to future launches, not existing processes or an
already reviewed queued launch. Cancel and re-arm a queued launch to apply edits.
Read-only mode takes effect immediately and also blocks interrupts; Stop remains
available. Clear View changes only the display, not an agent conversation.

Templates preserve dependencies within the copied tab; references to other tabs
are omitted. Worktree creation never deletes existing or dirty worktrees. Git
can execute configured checkout hooks, so only use trusted repositories.

## Agent integration and launch conditions

With shell integration enabled, scripts and wrappers can report explicit state:

```powershell
Send-PromptTerminalSignal -State working -Message 'Started task'
Send-PromptTerminalSignal -State waiting -Message 'Approval required'
Send-PromptTerminalSignal -State completed -Message 'Tests passed'
Send-PromptTerminalSignal -State directory -Message $PWD.Path
```

Running means that the shell host is alive, not that an agent is working.
Output, silence and exit codes are never guessed to be task completion.
Current directory/branch information requires the explicit `directory` signal;
otherwise the footer is labeled **Initial**. Metrics describe the shell host,
not the aggregate process tree.

A dependent launch waits for the reviewed prerequisite's explicit `completed`
signal and optional earliest start time. If the prerequisite is stopped when
armed, its next launch is expected. Removing/replacing it, or ending the expected
session without that signal, fails the queued launch visibly; review and start
again to re-arm it. One failed launch does not stop successful sibling sessions.

Agent-specific resume commands run only through the explicit Resume action.
They do not restore process memory, authentication or an agent conversation
unless the chosen CLI implements that behavior.

## Keyboard defaults

| Action | Shortcut |
|---|---|
| New tab / new pane | Ctrl+Shift+T / Ctrl+Shift+N |
| Split right / below | Ctrl+Shift+H / Ctrl+Shift+J |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Next / previous pane | Alt+Right / Alt+Left |
| Maximize / float | Ctrl+Shift+M / Ctrl+Shift+F |
| Command palette / terminal search | Ctrl+Shift+P / Ctrl+Shift+S |
| Copy selection | Ctrl+Shift+C |
| Paste | Ctrl+V, Ctrl+Shift+V, Shift+Insert |
| Interrupt focused shell | Ctrl+C |

Configured application shortcuts take precedence over terminal keys. Remove a
binding in Settings to let the shell receive it. IME composition and AltGr bypass
application shortcuts. Multiline paste is confirmed by default and xterm handles
bracketed-paste negotiation; unsupported shells may execute pasted newlines.
Terminal screen-reader output is opt-in in Settings: xterm changes browser text
insertion/emoji handling in that mode. Verify your assistive-technology/IME
combination.

## Storage, recovery and privacy

Configuration is stored in `%LOCALAPPDATA%\PromptTerminal\workspace.json`;
`workspace.json.bak` retains the previous save. Layout, profiles, snippets,
templates and settings are persisted; process IDs, native handles, live state and
session generations are not.

Configuration is **plain text**, not a credential store. Scripts, snippets and
environment overrides can contain secrets: do not put credentials in them.
Use **Export layout without scripts** when sharing; that removes startup/resume
scripts and environment values. Transcript export is explicit and warns about
sensitive terminal output. There is no automatic transcript or app telemetry.

Invalid configuration is not silently replaced. Recovery retains the original
as a separate timestamped file. If recovery is declined, a temporary workspace
opens with autosave disabled; Save requires explicit approval before replacement.

If the renderer fails, input is disabled and bounded output backpressure preserves
the pending batch. Recovery warns that the previous screen/history cannot be
restored; it recreates views without restarting the live processes. Stop is also
available. A restart creates a fresh terminal instance so even queued old-parser
work cannot reach the replacement session.

Only bundled renderer content is loaded. Navigation, downloads, browser
permissions and terminal clipboard escape writes are blocked. HTTPS links require
an explicit external-open confirmation. Agents still use your permissions,
credentials and network: panes are **not security or filesystem sandboxes**.

To isolate application configuration, including for tests:

```powershell
.\src\PromptTerminal.App\bin\Debug\net10.0-windows\PromptTerminal.App.exe --data-directory C:\Temp\PromptTerminal-test
```

One application instance per data directory is allowed in a Windows desktop
session to prevent competing autosaves. Closing confirms the affected live/queued
session count and stops only the pane-owned process trees. Interrupt first when
an agent needs a chance to finish gracefully.

## Validation

After building:

```powershell
# Fast model, persistence, real ConPTY, integration and Git checks:
dotnet test .\tests\PromptTerminal.Tests\PromptTerminal.Tests.csproj --no-build --filter "Category!=Qualification"

# 100 forced start/stop cycles with job ownership and native-handle checks:
dotnet test .\tests\PromptTerminal.Tests\PromptTerminal.Tests.csproj --no-build --filter "Category=Qualification" --logger "console;verbosity=detailed"

# Real xterm renderer with an explicitly mocked desktop bridge:
npm run test:ui

# WPF + WebView2 + real PowerShell, with isolated temporary configuration:
npm run test:desktop

# Test a published executable instead of the default Debug build:
npm run test:desktop -- .\artifacts\publish\win-x64\PromptTerminal.App.exe
```

The browser tests use locally installed Microsoft Edge. The desktop smoke test
requires an interactive Windows desktop and the Debug build. It checks twelve
real concurrent sessions, focused input, Unicode, live layout/theme changes,
restart generation rejection, explicit dependencies, renderer recovery,
partial failures and stopped restore. It temporarily enables **loopback-only**
WebView2 debugging for that test process; normal launches do not enable it.
It can briefly run thirteen shells, so allow sufficient resources.

The lifecycle qualification warms up first, then measures native handles after
each ten forced-stop cycles. A successful observed run held **499 handles at all
ten checkpoints**. This is measured test evidence, not an unlimited-session or
general leak-free guarantee.

Remaining release qualification: actual target agent CLI/version compatibility,
full-screen/mouse behavior, real screen-reader/IME checks, physical mixed-DPI
displays, Windows appearance-change checks, installer/signing, and the specified
20-session ten-minute latency/load and memory-budget measurements. The structural
configuration limits (100 tabs, 200 panes/tab) are not supported concurrency claims.
Detached windows, WSL/remote/container profiles and provider-API orchestration are
outside this release.

## Publish

```powershell
dotnet publish .\src\PromptTerminal.App\PromptTerminal.App.csproj -c Release -r win-x64 --self-contained false -o .\artifacts\publish\win-x64
```

Copy the **entire** output directory, including Web assets and WebView2 loader,
not just the executable. This framework-dependent build requires the .NET 10
Desktop Runtime and WebView2 Evergreen Runtime on the destination machine.
See [the specification](SPECIFICATION.md) for requirements and release gates.
