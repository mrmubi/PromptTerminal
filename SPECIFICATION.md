# Prompt Terminal - Product and Technical Specification

Status: Implemented application with automated validation; remaining release
qualification is documented in [README.md](README.md).

## 1. Product goal

Build a C# Windows desktop application for organizing multiple independent
PowerShell sessions, especially sessions running different command-line agents.

Users organize work into tabs. Each tab contains multiple embedded terminal
panes. Panes support both tiled splits and freely movable, resizable floating
panels, as selected for this specification.

Example: a project tab runs a coding agent, a reviewing agent, a test runner,
and an ordinary PowerShell prompt, all visible in one workspace.

## 2. Confirmed requirements and recommended defaults

| Area | Requirement or recommendation |
|---|---|
| Application | Windows desktop application with a C# host. |
| Tabs | Multiple independent workspaces in one application window. |
| Layout | Hybrid: tiled splits and floating panels within the same tab. |
| Sessions | One independent PowerShell process and pseudoconsole per pane. |
| Startup | Optional user-provided startup command or multiline PowerShell script per pane. |
| Agents | Run installed interactive agent CLIs without requiring provider-specific APIs. |
| Recommended platform | Supported Windows 11 releases, x64, for the first release. |
| Recommended stack | .NET 10 LTS, WPF, MVVM, Windows ConPTY, and a mature terminal renderer. |
| Recommended renderer | Locally bundled xterm.js in WebView2; see architecture below. |
| Themes | Dark and Light (white), with an option to follow Windows appearance. |
| Storage | Local, versioned JSON configuration; no cloud account required. |

"Windows" inside a tab means embedded terminal panels, not external PowerShell
console windows. Detached operating-system windows are outside the first release.

The recommended renderer uses JavaScript for terminal presentation. The desktop
host, process management, persistence, and application logic remain C#.

## 3. Core user journey

1. Create a tab called `My Project`.
2. Add a pane and choose its shell, working directory, name, and startup command.
3. Configure the first pane to start an installed agent CLI.
4. Split the workspace and start another agent in a second pane.
5. Add a test-runner pane and float it over the tiled workspace.
6. Resize, move, maximize, or dock panes without restarting their processes.
7. Switch tabs while all existing sessions continue running.
8. Save the workspace layout and launch configuration.
9. Later, reopen the saved layout and explicitly start its sessions.

Illustrative workspace:

```text
+-----------------------------------------------------------------------+
| My Project | Operations | Experiments | +                              |
+-----------------------------------------------------------------------+
| Coding agent                     | Reviewing agent                    |
| C:\repos\project-coding           | C:\repos\project-review             |
|                                  |                                    |
|                                  |   +----------------------------+   |
|                                  |   | Floating test runner       |   |
|                                  |   | dotnet test                 |   |
|                                  |   +----------------------------+   |
+----------------------------------+------------------------------------+
| General PowerShell                                                    |
+-----------------------------------------------------------------------+
```

Different agents can modify the same files if they share a directory. Separate
PowerShell processes are not filesystem isolation. Recommend separate Git
worktrees for agents making independent changes.

## 4. MVP functional requirements

### FR-01: Tab management

- Create, rename, reorder, and close tabs.
- Display a custom name and optional color per tab.
- Preserve sessions, input state, and terminal contents when switching tabs.
- Indicate unread output in inactive tabs without claiming an agent needs help.
- Closing a tab containing live sessions requires confirmation showing how many
  sessions will stop.

### FR-02: Hybrid pane layout

- Split a tiled pane horizontally or vertically.
- Resize tiled panes using draggable splitters.
- Move and resize floating panels using their title bars and borders.
- Dock a floating panel into the tiled layout using a visible placement preview.
- Undock a tiled pane into a floating panel.
- Move a pane between tabs without restarting its session.
- Bring a floating panel to the front when selected.
- Temporarily maximize a pane, then restore its previous position and size.
- Preserve terminal focus and process identity during layout changes.
- Keep floating title bars reachable after window resizing or DPI changes.
- Default new panes to the current floating format when present, preserving
  panel size and placing them alongside; otherwise inherit tiled split
  direction. Explicit floating/tiled and right/below choices remain available.
- Apply minimum usable pane dimensions. When the available area is insufficient,
  provide workspace scrolling or a clear layout adjustment rather than hiding
  panels or shrinking terminals to zero.

Floating panels belong only to their containing tab. They do not appear above
other tabs or outside the application window.

### FR-03: Pane configuration and launch profiles

Each pane supports:

- Display name and accent color.
- Selected PowerShell executable.
- Initial working directory.
- Optional startup command or multiline startup script.
- Optional non-secret environment variable overrides.
- Whether to load the user's PowerShell profile.
- Whether to leave the shell open after the startup command returns.

Recommend PowerShell 7 when installed. Windows PowerShell 5.1 can be selected
explicitly and must have its own compatibility tests. Do not silently substitute
one shell version for another.

Allow saving reusable launch profiles. Editing a profile must not modify a
running process. Apply changes to future launches or an explicitly confirmed
restart.

Launch rules:

- Validate the shell executable and working directory before starting.
- Create the process with its working directory and environment already set.
- Execute the startup script once per launch, after the selected shell's normal
  initialization, inside that same shell session.
- Do not simulate startup by blindly pasting keystrokes into a terminal.
- Treat the startup script as intentional executable code, not as ordinary text.
- Keep executable paths and process arguments separate from script content.
- Preserve quoting, spaces, Unicode paths, and multiline scripts.
- Duplicating a pane creates a new session and runs its startup command again;
  it does not copy process memory or reconnect to the original agent.

### FR-04: Full interactive terminal behavior

Each pane must behave like a terminal, not a redirected-output text box.

- Support ANSI/VT colors, cursor movement, screen clearing, alternate-screen
  applications, keyboard input, and terminal mouse modes.
- Support PowerShell editing and history, Ctrl+C, tab completion, and interactive
  agent interfaces.
- Support Unicode, text selection, copy, paste, scrolling, and configurable font
  size.
- Resize the pseudoconsole in character columns and rows as the pane changes.
- Keep reading output from hidden panes and inactive tabs.
- Provide bounded scrollback, initially 10,000 lines per pane.
- Preserve output ordering and UTF-8 characters split across pipe reads.
- Use bounded queues and backpressure; never discard arbitrary terminal bytes
  to make the UI appear responsive.
- Confirm multiline paste by default and respect bracketed-paste support.

ConPTY provides a terminal stream, not reliably separate stdout and stderr.
Do not promise separate stderr coloring or capture without additional integration.

### FR-05: Session controls and truthful status

Pane controls include Start, Interrupt, Restart, Close, Clear View, and Maximize.

Session states:

| State | Meaning |
|---|---|
| Not started | Configuration exists, but no process is attached. |
| Starting | Pseudoconsole and process initialization are in progress. |
| Running | The PowerShell host process is alive. |
| Stopping | Session shutdown is in progress. |
| Exited | The host process ended; show its exit code when available. |
| Failed | Session creation or attachment failed; show an actionable error. |

- Keep the final terminal contents visible after exit until the pane is closed
  or restarted.
- Restarting a live session requires confirmation and visibly starts a new
  process.
- Clear View changes terminal presentation only; it does not clear an agent's
  conversation or stop its work.
- Offer Ctrl+C before forced termination. Do not promise graceful shutdown for
  every CLI.
- A forced stop targets only the pane-owned process tree, never processes
  selected by name.
- Do not automatically restart failed agents in the MVP.

`Running` does not mean that an agent is actively working. Silence does not mean
completion, failure, or waiting for approval. Reliable agent-specific states
require explicit integrations or launch wrappers, introduced separately.

### FR-06: Save, reopen, and recover workspaces

- Save tab order, pane names, launch settings, tiled split ratios, floating
  bounds, z-order, and the selected tab.
- Autosave layout changes using atomic file replacement and retain a last-known
  valid configuration.
- Reopen saved configurations without automatically executing their scripts.
- Provide an explicit Start Workspace action with a preview of commands and
  working directories.
- If only some panes fail to launch, keep successful sessions running and show
  errors on the affected panes.
- Warn before closing the application while sessions are running.
- On reopening after a crash, restore the saved layout and clearly label its
  sessions as not started.
- Remember main-window normal size and maximized state in logical pixels,
  constrained to the current work area; minimizing must not overwrite them.

Persistence restores configuration, not a live process, PowerShell variables,
agent memory, or an authenticated connection. Agent resume commands can be
configured when the particular CLI supports them.

### FR-07: Keyboard-first operation

Provide configurable shortcuts for:

- New tab and new pane.
- Horizontal and vertical split.
- Next/previous tab and next/previous pane.
- Maximize/restore active pane.
- Dock/undock active pane.
- Command palette.

Only the focused terminal receives keyboard input. Application shortcuts and
terminal shortcuts must have documented precedence and configurable conflicts.
Provide keyboard-accessible alternatives to dragging and resizing.

### FR-08: Visible errors

Show actionable errors for missing shells or WebView2 runtime, invalid working
directories, process creation failures, invalid configuration, and save failures.

Never replace invalid configuration with an empty workspace without warning.
Retain the original file and offer recovery from the last-known valid version.

If a renderer fails, preserve any still-running sessions, stop accepting input
for the affected view, and show explicit recovery or stop options. Never silently
restart agents or claim that the terminal was restored without restoring its state.

### FR-09: Dark and white/light themes

- Provide Dark, Light (white), and System theme options in application settings.
- Default to System on first launch. Explicit Dark or Light selection overrides
  Windows appearance; System follows Windows appearance changes automatically.
- Use a low-glare dark background for Dark and white content and terminal
  backgrounds with dark text for Light.
- Apply the selected theme consistently to tabs, pane headers, floating panels,
  splitters, menus, dialogs, settings, and terminal default colors.
- Switch themes immediately across active and inactive tabs without restarting
  PowerShell processes, losing terminal contents, changing layout, or moving focus.
- Persist the theme preference across application restarts.
- Share semantic color tokens between the WPF host and the terminal renderer,
  including text, backgrounds, borders, focus, selection, and status indicators.
- Provide suitable ANSI palettes for both themes. Honor explicit application
  colors; do not promise to recolor agent interfaces that set their own colors.
- Require at least 4.5:1 contrast for default normal-sized application text and
  terminal foreground/background pairs. Do not communicate status by color alone.

## 5. Suggested features and priority

| Priority | Feature | Benefit and guardrail |
|---|---|---|
| P0 | Hybrid layouts | Arrange agents in tiled or floating panels without restarting them. |
| P0 | Named launch profiles | Start a particular agent, shell, folder, and command consistently. |
| P0 | Workspace save and restore | Reuse a project setup without promising live-session resurrection. |
| P0 | Per-pane names, colors, and process status | Distinguish agents and see which hosts are still running. |
| P0 | Dark and white/light themes | Switch the entire interface and terminal default palette live, with a saved preference and System mode. |
| P1 | Workspace templates | Create a Planner / Implementer / Reviewer / Tests setup in one action. |
| P1 | Git worktree assistance | Give coding agents independent working directories; never delete dirty worktrees automatically. |
| P1 | Attention and completion notifications | Use explicit integrations; label output-based guesses as heuristics. |
| P1 | Terminal search and opt-in transcript export | Find prior output; warn that transcripts may contain secrets. |
| P1 | Prompt snippets | Insert reusable task instructions into one selected pane for review before sending. |
| P1 | Duplicate tab | Create fresh sessions from an existing tab's layout after reviewing startup commands. |
| P1 | Command palette | Quickly find profiles, panes, tabs, and layout actions. |
| P1 | Git branch and directory indicators | Report live values only when shell integration is available; otherwise label the initial directory. |
| P2 | Broadcast input | Explicitly select recipients, show a persistent warning, and require a deliberate send action. |
| P2 | Agent-specific integrations | Show waiting-for-approval, task completion, and resume options when supported. |
| P2 | Scheduled and dependent startup | Reviewed daily/weekday/weekly local-time recurrence and explicit prerequisite signals; skip busy/missed runs; never auto-arm restored schedules. |
| P2 | App-only keep-awake | Opt-in idle sleep/hibernate prevention while open; release on exit without modifying Windows power configuration. |
| P2 | CPU and memory indicators | Identify expensive sessions, with clear limits on process-tree attribution. |
| P2 | Read-only monitoring mode | Prevent accidental typing into selected sessions. |
| P2 | Detached workspace windows | Move tabs into separate application windows without losing sessions. |

Most valuable additions after the MVP: workspace templates, Git worktree
assistance, and reliable attention notifications.

## 6. Recommended technical architecture

### Desktop host

- C# with .NET 10 LTS and WPF.
- MVVM for application state, commands, and testable view models.
- A native shell for tabs, menus, profile editing, dialogs, and settings.
- A small number of cohesive components rather than an early plugin framework:
  workspace/layout management, terminal session hosting, rendering bridge, and
  persistence.

Implementation note: the WPF window hosts one locally bundled WebView2 surface
for the tab strip, pane controls, forms and terminal views. Native C# dialogs
handle launch review, file selection and shutdown/recovery confirmation. The
testable C# workspace command/model layer is authoritative; JavaScript owns
transient form state, drag previews and terminal presentation. This intentionally
uses versioned state snapshots rather than WPF bindings for the embedded UI,
avoiding overlapping HWND-backed controls while preserving terminal identity
during layout changes.

### Terminal hosting

- Create one Windows ConPTY instance and one PowerShell host per pane.
- Use the Windows pseudoconsole APIs rather than reparenting external console
  windows or relying only on redirected standard streams.
- Service blocking pipe reads and writes independently, off the WPF dispatcher,
  using cancellation-aware workers.
- Use safe native-handle ownership and deterministic cleanup for processes,
  pipes, pseudoconsole handles, and any process-tracking resources.
- Track the pane-owned process tree, preferably using a Windows Job Object with
  an explicitly tested containment and shutdown policy.
- Configure ownership before allowing the child to run, so an immediately
  spawned agent is not missed. Surface containment setup failures.
- Keep output draining during shutdown where required to avoid pseudoconsole
  deadlocks.

### Terminal rendering and hybrid layout

- Bundle a maintained xterm.js version and its required assets locally.
- Use one shared WebView2 rendering surface for the workspace area. Keep each
  tab's terminal containers mounted within it; switching tabs changes visibility,
  not terminal lifetime.
- Keep overlapping panels and cross-tab pane moves within that same rendering
  surface rather than overlapping independent HWND-backed terminal controls or
  recreating terminals when moving them.
- Keep the authoritative layout model in C# and persist only committed changes.
- Use explicit, typed, versioned messages for input, output, resize, focus, and
  layout updates.
- Include pane identity and session generation in messages so delayed output or
  input cannot attach to a replacement session after restart.
- Batch output with flow control. Do not dispatch one UI operation per character.
- Measure inactive-tab behavior, memory, focus, IME, accessibility, and mixed-DPI
  rendering in an early compatibility prototype.

This design deliberately reuses a terminal emulator instead of implementing
ANSI/VT interpretation from scratch. It requires a local WebView2 runtime but
does not require a web server or remote web application.

### Persistence model

Use versioned JSON with validation and explicit schema migration.

| Entity | Key persisted information |
|---|---|
| Application settings | Theme preference (`dark`, `light`, or `system`), font, shortcuts, scrollback limit, shell defaults, app-only keep-awake preference. |
| Main window | Normal logical width/height and maximized state, separate from renderer settings. |
| Launch profile | Shell, initial directory, startup script, non-secret environment overrides, shell flags. |
| Workspace | Schema version, tabs, selected tab, referenced or snapshotted launch settings. |
| Tab | Stable ID, name, color, tiled layout root, ordered floating-pane collection. |
| Split node | Orientation, split ratio, two children; leaves reference pane IDs. |
| Floating placement | Pane ID, logical bounds, z-order. |
| Pane | Stable ID, name, color, resolved launch configuration, placement membership, optional daily/weekday/weekly recurrence and local time/day. |

A pane belongs to exactly one tab and either one tiled leaf or one floating
placement, never both. Reject duplicate IDs, invalid split ratios, orphaned
references, unsupported schema versions, and non-finite bounds.

Persist floating geometry in DPI-independent units and split geometry as ratios.
Reconcile saved bounds with the current viewport during restore.

Do not persist process IDs, native handles, live-state flags, or runtime
credentials as launchable state.

Recurring approvals, reviewed snapshots and next-run/status information are
runtime-only. Users explicitly review and arm each schedule per app session.
Each run uses its approved snapshot in a fresh shell that closes after its
startup script; live/queued panes are skipped rather than interrupted.
Occurrences missed by more than one minute are not replayed. DST gaps are
skipped and ambiguous local times execute once. Import, recovery, shutdown and
Stop disarm applicable schedules. A renderer outage pauses scheduling and uses
the same missed-run rule on recovery.

Illustrative launch profile, assuming the CLI is installed and authenticated:

```json
{
  "schemaVersion": 1,
  "name": "Coding agent",
  "shell": {
    "executable": "pwsh.exe",
    "loadUserProfile": true
  },
  "workingDirectory": "C:\\repos\\project-coding",
  "startupScript": "copilot",
  "environment": {},
  "keepShellOpen": true,
  "accentColor": "#4F86F7"
}
```

Resolve and display the actual shell executable before launch. The example
directory and agent command are illustrative, not application dependencies.

## 7. Safety, privacy, and scope boundaries

- All sessions run with the current user's permissions. Pane separation is not
  a security sandbox.
- No elevation or automatic credential provisioning in the MVP.
- Never auto-execute startup scripts from imported or recovered configuration.
- Show commands and environment overrides before starting an imported workspace.
- Avoid storing secrets in workspace files. Command text itself may contain
  secrets; warn before saving or exporting it and allow its omission.
- Rely on each CLI's normal authentication flow rather than copying its tokens.
- Disable terminal transcripts and telemetry by default.
- Operational diagnostics must not include terminal contents or environment
  values by default.
- Treat terminal output as untrusted text, not HTML or native host instructions.
- Restrict WebView2 to bundled application content. Validate message origins,
  message schemas, target panes, and allowed operations.
- Block navigation and new browser windows inside the terminal surface.
- Allow only approved link schemes, such as HTTPS, through a user-initiated
  external-open action.
- Do not allow terminal escape sequences to run commands or write the clipboard
  without explicit user permission.
- Network access by agents is their own behavior; the application does not
  promise offline agents or control their provider billing.

Not included in the MVP: provider API orchestration, cross-agent context sharing,
autonomous task delegation, remote machines, containers, WSL profiles, or
surviving application exit with detached background sessions.

## 8. Acceptance criteria

These are release gates, not claims that every hardware, accessibility, agent
compatibility or performance qualification has been completed. Automated coverage
and remaining manual checks are summarized in [README.md](README.md).

| ID | Test | Expected result |
|---|---|---|
| AC-01 | Create three tabs with four PowerShell panes each. | All 12 sessions have independent process identities and accept input only in the focused pane. |
| AC-02 | Assign different startup commands and directories. | Each command starts exactly once in the intended directory; environment changes do not leak to sibling panes. |
| AC-03 | Split, float, dock, resize, maximize, and move a live pane to another tab. | Its process identity and terminal state remain unchanged. |
| AC-04 | Produce output in an inactive tab, then return. | Output remains correctly ordered and scrollback respects the configured limit. |
| AC-05 | Exercise a full-screen interactive CLI. | Cursor addressing, alternate screen, keyboard input, mouse modes where used, and resize behave correctly. |
| AC-06 | Use paths with spaces and non-ASCII characters, multiline startup scripts, and split UTF-8 output sequences. | No quoting corruption, lost characters, or duplicate script execution. |
| AC-07 | Exit one shell and fail another pane's launch. | Other panes continue; exited output is retained and launch errors are visible. |
| AC-08 | Close a live pane, tab, or application. | Confirmation identifies the affected sessions; cancellation leaves them running. |
| AC-09 | Force-stop a session that spawned child processes. | Only that session's owned process tree stops; sibling and unrelated processes survive. |
| AC-10 | Save and reopen a mixed tiled/floating layout. | Tab order, placement, names, and commands restore, but no commands run until explicitly started. |
| AC-11 | Restore after a crash or open a corrupt configuration. | Valid saved state is recoverable; corruption is reported without silently overwriting the original. |
| AC-12 | Open a workspace containing startup code or output containing HTML and escape sequences. | Import does not run code; output cannot invoke privileged bridge operations or silently write the clipboard. |
| AC-13 | Move between 100%, 150%, and 200% DPI displays and reduce window size. | Text and terminal dimensions update; every floating panel remains reachable. |
| AC-14 | Delay renderer messages while restarting a pane. | Old-generation input and output cannot affect the replacement session. |
| AC-15 | Complete 100 start/stop cycles. | No pane-owned processes remain after stop; native handle counts do not grow monotonically. |
| AC-16 | Complete keyboard-only and screen-reader smoke tests. | Tabs, pane selection, configuration, and terminal access remain usable. |
| AC-17 | Switch between Dark and Light with tiled and floating panes across multiple tabs. | All application surfaces and terminal default palettes update immediately; process identities, terminal contents, layout, and focus remain unchanged. |
| AC-18 | Save a theme, restart, and test Windows appearance changes in System mode. | The preference persists; only System mode follows Windows appearance changes. |
| AC-19 | Check default text colors and status indicators in both themes. | Default normal-sized application text and terminal foreground/background pairs meet 4.5:1 contrast; status remains understandable without color. |

Initial performance qualification:

- Reference machine: Windows 11 x64, four or more CPU cores, 16 GB RAM, SSD,
  1920 x 1080 display.
- Test five tabs and 20 live sessions. This is a tested envelope, not a promise
  of unlimited sessions.
- With 19 background sessions each producing up to 50 KiB/s of synthetic output,
  target active-pane keyboard echo at or below 100 ms p95 and tab switching at or
  below 250 ms p95 over a ten-minute run.
- Measure shell startup separately from user profile loading, authentication,
  agent startup, and network latency.
- Record C# host and WebView2 memory separately from shells and agents. Establish
  the release memory budget during the prototype using the configured scrollback
  limit rather than making an unmeasured memory promise.
- If the supported session limit needs a hard cap, decide it from measurements
  and document the user-visible limit before implementation is accepted.

## 9. Delivery plan

1. **Compatibility prototype:** one PowerShell ConPTY session, local renderer,
   interactive agent, resizing, Unicode, focus, mixed DPI, and process cleanup.
   Then verify overlapping floating panels and multi-session output load.
2. **Core application:** tabs, hybrid layout, launch profiles, process lifecycle,
   errors, keyboard operation, independent sessions, and dark and white/light
   themes with live switching.
3. **Persistence and hardening:** atomic save/recovery, safe imports, shutdown,
   accessibility, compatibility tests, and performance qualification.
4. **Agent-workspace improvements:** templates, worktree assistance, search,
   prompt snippets, and integration-backed notifications.

Do not proceed with broad feature development if the terminal compatibility
prototype fails the actual agent CLIs the application is intended to host.

## 10. Decisions to finalize before implementation

- Exact agent CLIs and versions used in the compatibility matrix.
- Whether zero JavaScript is mandatory; the recommended renderer requires it.
- Whether Windows PowerShell 5.1, Windows ARM64, or older Windows releases need
  first-release support rather than later qualification.
- Installer and signing strategy, including WebView2 runtime availability.
- A measured session-count policy and memory budget.

The hybrid layout choice is already confirmed; these remaining items are
recommendations or release-planning decisions, not additional confirmed requests.

## 11. Technical references

- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [Creating a Windows pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
- [WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)
- [xterm.js documentation](https://xtermjs.org/docs/)
