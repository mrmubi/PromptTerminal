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
The new-pane dialog also offers **Add and start pane**: its native review creates
and starts only that pane after approval. Canceling the review or failing launch
validation leaves the dialog open without adding a pane. **Add unstarted pane**
remains the default action, including when submitting with Enter.

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
- Atomic JSON autosave with OneDrive-backed defaults, a last-save backup, explicit recovery, safe layout
  import and script-free export by default.
- Workspace templates, prompt snippets, command palette, Git worktree creation,
  explicit integration notifications, scheduled/dependent startup, deliberate
  broadcast input and shell-host CPU/memory indicators.
- Opt-in keep-awake mode; reviewed hourly, daily, weekday and weekly agent tasks;
  responsive floating grids and remembered main-window size/maximized state.

Automatic floating grids reflow when the window changes size; free-positioned
floating title bars are clamped to reachable positions after a viewport change.
Large tiled layouts scroll rather than shrinking terminals below usable bounds.
For keyboard-only floating layout changes, edit Left/Top/Width/Height in pane
configuration. Use **Tab options** to rename, color, reorder or duplicate a tab.
Alt+drag a floating title bar over a tiled pane to preview docking, or use its
**Dock with placement preview** action.

New panes and duplicates **float by default**, even in a tiled-only tab. They
append after the last pane, not the most recently focused pane. By default,
adding a floating pane brings all panes in that tab into an equal-sized grid,
so no tiled panes are hidden underneath. The main window widens to make room
without exceeding the current monitor's work area or changing its height.
At the width limit, or when you resize the window yourself, panes reflow into
rows and columns. Adding a pane never unmaximizes the window.

Use **Tab options > Auto-arrange floating panes in an equal grid** to turn
automatic reflow off for persistent free positioning, or back on to restore it.
Manual pane moves/resizes in automatic mode last until the next reflow.
Uncheck **Create as floating panel**, explicitly **Split right / below**, or
**Dock** to opt that tab into manual hybrid layout instead. Tiled additions
inherit the target's split direction. Window size is saved in logical pixels,
with normal restore dimensions retained when maximized or minimized. Restored
dimensions are constrained to the current Windows work area.

Launch/profile/plan edits apply to future launches, not existing processes or an
already reviewed queued launch or armed schedule. Cancel and re-arm to apply edits.
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
Terminal output automatically shows a rotating 3-pixel red/coral border with a
soft glow, highlights the title bar in red and gently fades the title. This works
for manual and scheduled runs without shell integration or signal commands.
Without an explicit task state, the animation stops after **two seconds without
new output**. An explicit **working** or **waiting** signal keeps it animated,
even through silence. **Completed** stops it immediately, and later output does
not restart it until another working/waiting signal or a new session. Stopping
the process always stops animation. Empty/replayed/stale output and state
refreshes do not extend the output timeout. The visual indicator never invents
task states, infers completion or releases dependencies based on output.
Reduced-motion and high-contrast preferences use a steady activity border
instead; animations pause in hidden tabs and masked panes.
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

## Keep-awake and recurring tasks

In **Settings**, enable **Prevent automatic sleep / hibernation while app is
open** to let long-running agents continue through Windows idle time. This
app-only Windows power request needs no administrator rights, does not alter
system hibernation settings, and is released on exit. The display can still turn
off. Explicit sleep/hibernate, shutdown, lid and critical-battery policies can
still suspend or stop work; this is not an unconditional 24/7 guarantee.

To schedule an agent:

1. Edit its pane and enter the actual CLI command/script.
2. Select **Hourly (on the hour)**, **Daily**, **Weekdays (Mon-Fri)** or **Weekly**.
   Hourly runs at the next local `:00` boundary and every hour afterward; it
   does not use a chosen time/day. Other frequencies use a local time and, for
   weekly tasks, a day. The optional earliest launch time remains a lower bound.
3. Open **Schedules** or pane actions and **Review and arm** the native launch
   preview. Merely saving a recurrence does not execute or arm it.

Each occurrence starts a fresh shell with the reviewed script, environment and
working directory. **Any pane configured with a recurrence closes its shell
when the command finishes**, including manual Start, Restart, Resume, Start
workspace and Add and start. Its **Keep shell open** checkbox is automatically
cleared and unavailable while recurrence is selected. This also applies to
older saved recurring panes whose profile still has keep-open enabled, so an
idle manual prompt cannot block the next occurrence. Ordinary panes without
recurrence retain their chosen keep-open behavior. These defaults affect new
launches only; an already running session is not forcibly closed.

Existing live or queued sessions are never stopped to make room: that occurrence
is skipped visibly. Dependencies still require their expected explicit completion signal.
Run noninteractive agent commands for unattended work; authentication, approval
or input prompts can keep a task alive and cause later occurrences to skip.

Schedules run only while this app and its renderer are available. They are
runtime-only approvals: reopening, importing or recovering configuration never
re-arms them. Disarm/review again to apply edits to an approved snapshot.
Disarming leaves an already running occurrence alone; **Stop** also disarms
future runs. An occurrence missed by more than one minute is skipped, without
catch-up bursts. Local daylight-saving gaps are skipped; repeated wall-clock
times run once per date for daily/weekday/weekly tasks. Hourly tasks include both
occurrences of a repeated hour, so each actual local `:00` boundary is eligible.
Next run and skipped/queued status appear in
**Schedules** and pane footers.

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

By default, configuration is stored in the signed-in OneDrive folder at
`PromptTerminal\workspace.json`. The app checks `OneDrive`, `OneDriveCommercial`,
then `OneDriveConsumer` environment variables, using the first configured root.
With no OneDrive configured, it retains the local default:
`%LOCALAPPDATA%\PromptTerminal\workspace.json`. A configured but unavailable
OneDrive folder produces an error rather than silently starting a second local
workspace. **Settings** and the save-status tooltip show the exact active path.

On the first default OneDrive launch, an existing local workspace and its backup
are copied without deleting or changing the originals. An existing OneDrive
workspace always wins, including when it requires recovery; local data never
silently replaces it. Migration is recorded locally so deleting a synced file
does not repeatedly import an old local workspace.

Use the updated app with the **same OneDrive account on each PC**. Wait for
OneDrive to finish syncing before opening the app on another PC. Changes are
loaded **on app startup**, not hot-reloaded into running sessions. Avoid editing
the workspace from multiple PCs simultaneously: this is file sync, not live
collaboration. If an external change has already reached the local file, the
app pauses autosave instead of overwriting it. Restart to load that version, or
use **Save now** to explicitly retain it as a recovery file and replace it.
OneDrive owns upload/download status; **Saved to OneDrive folder** does not
claim that a cloud upload has completed. Offline or simultaneous edits can still
produce OneDrive conflicted copies that need manual resolution.

`workspace.json.bak` retains the previous save. Layout, profiles, snippets,
templates and settings are persisted; process IDs, native handles, live state and
session generations are not. Main-window restore size/maximized state and
recurrence definitions are saved; armed approvals and next-run runtime state are
not.
WebView2 caches remain under local application data and are not migrated to
OneDrive. Running processes, terminal history, external tool sign-ins and armed schedule
approvals do not move between PCs. Commands and working-directory paths must
exist on each PC; supported Windows environment variables such as `%USERPROFILE%`
can make configured paths portable.

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
session to prevent competing autosaves on that PC, not across PCs. Default
OneDrive launches also reserve the original local directory to prevent an older
local-data instance running during migration. The explicit `--data-directory`
override remains available and does not migrate the default local workspace.
Closing confirms the affected live/queued
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

For just the keep-awake, recurring-task, floating-placement and window-restore
desktop checks, append `--features-only` (an executable path is optional).
These checks also cover reviewed add-and-start, canceled/invalid pane creation,
and hourly schedule arming at the next local hour.
Use `--recurring-defaults-only` to focus on recurring manual-launch auto-close,
normal interactive prompts, reviewed add-and-start and actual scheduled/busy runs.
Use `--floating-layout-only` for native default-floating creation, duplication,
equal grid reflow, monitor-limited window growth, normal/maximized restore and
live process/terminal-history preservation.
Use `--activity-only` for real manual and scheduled output with integration
disabled, explicit working/waiting/completed animation overrides, idle-shell
exclusion, reduced-motion handling and cleanup after exit.
Use `--storage-only` for external-change protection, explicit replacement with
retained originals, isolated data-directory overrides and startup-only reload.

The browser tests use locally installed Microsoft Edge. The desktop smoke test
requires an interactive Windows desktop and the Debug build. It checks twelve
real concurrent sessions, focused input, Unicode, live layout/theme changes,
restart generation rejection, explicit dependencies, renderer recovery,
partial failures, real recurring launches/busy skips, keep-awake toggling,
floating placement, window-size restore and stopped/unarmed restore.
It temporarily enables **loopback-only**
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
