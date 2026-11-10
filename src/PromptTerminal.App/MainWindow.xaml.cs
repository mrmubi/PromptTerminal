using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using PromptTerminal.Core.Git;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Persistence;
using PromptTerminal.Core.Terminal;

namespace PromptTerminal.App;

public partial class MainWindow : Window
{
    private const string RendererUrl = "https://promptterminal.local/index.html";
    private readonly WorkspaceStore _store = new(Path.Combine(App.DataDirectory, "workspace.json"));
    private readonly SemaphoreSlim _commands = new(1, 1);
    private readonly Dictionary<Guid, PaneRuntime> _runtimes = [];
    private readonly Dictionary<Guid, long> _generations = [];
    private readonly Dictionary<Guid, Guid> _maximized = [];
    private readonly HashSet<Guid> _unread = [];
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private ApplicationDocument _document = WorkspaceDefaults.Create();
    private CancellationTokenSource? _saveDelay;
    private Task _saveTask = Task.CompletedTask;
    private bool _ready, _initializing, _checkingQueue, _shuttingDown, _allowClose;
    private bool _recreateBrowser;
    private CoreWebView2? _activeCore;
    private bool _persistenceEnabled = true, _dark = true;
    private int _ticks;
    private string _saveStatus = "Not saved yet";

    public MainWindow()
    {
        InitializeComponent();
        _timer.Tick += OnTimer;
        SystemEvents.UserPreferenceChanged += OnSystemAppearanceChanged;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await LoadWorkspaceAsync();
            ApplyHostTheme();
            await InitializeRendererAsync();
            _timer.Start();
        }
        catch (Exception error)
        {
            ShowRendererFailure("Prompt Terminal could not start", error.Message);
        }
    }

    private async Task LoadWorkspaceAsync()
    {
        try
        {
            _document = await _store.LoadAsync() ?? WorkspaceDefaults.Create();
            _saveStatus = File.Exists(_store.Path) ? "Restored - sessions not started" : "New workspace";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException)
        {
            _persistenceEnabled = false;
            _saveStatus = "Recovery required - autosave disabled";
            if (File.Exists(_store.BackupPath) && Confirm("Recover saved workspace",
                    $"The configuration could not be opened:\n{error.Message}\n\nOriginal: {_store.Path}\n\n" +
                    "Restore the last valid backup? The original file will be retained, and no sessions will start.", "Recover backup"))
                await RestoreBackupAsync();
            else
                MessageBox.Show(this, "A temporary, unsaved workspace will open. The original configuration is unchanged.\n\n" +
                    "Use Workspace > Recover backup, or Save to explicitly replace it after retaining a copy.",
                    "Workspace recovery required", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async Task InitializeRendererAsync()
    {
        if (_initializing) return;
        _initializing = true;
        try
        {
            var assets = Path.Combine(AppContext.BaseDirectory, "Web");
            if (!File.Exists(Path.Combine(assets, "index.html")) || !File.Exists(Path.Combine(assets, "vendor", "xterm.js")))
                throw new FileNotFoundException("Local renderer assets are missing. Run npm ci, then rebuild the application.");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(App.DataDirectory, "WebView2"));
            await Browser.EnsureCoreWebView2Async(environment);
            var core = Browser.CoreWebView2;
            _activeCore = core;
            _recreateBrowser = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.SetVirtualHostNameToFolderMapping("promptterminal.local", assets, CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting += (_, args) =>
            {
                if (!string.Equals(args.Uri, RendererUrl, StringComparison.Ordinal)) args.Cancel = true;
            };
            core.FrameNavigationStarting += (_, args) => args.Cancel = true;
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
            core.DownloadStarting += (_, args) => args.Cancel = true;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, args) =>
            {
                if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var uri) ||
                    uri.Scheme != "https" || uri.Host != "promptterminal.local")
                    args.Response = environment.CreateWebResourceResponse(null, 403, "Blocked", "");
            };
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (_, args) =>
            {
                if (!ReferenceEquals(_activeCore, core)) return;
                _recreateBrowser = args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited;
                ShowRendererFailure("Terminal renderer stopped",
                    $"{args.ProcessFailedKind}. Sessions have not been restarted or stopped. Input is disabled and output is backpressured.\n\n" +
                    "Reloading recreates the views, not their previous screen/history. Existing processes continue. You can stop them instead.");
            };
            core.NavigationCompleted += (_, args) =>
            {
                if (ReferenceEquals(_activeCore, core) && !args.IsSuccess)
                    ShowRendererFailure("Terminal renderer could not load", args.WebErrorStatus.ToString());
            };
            core.Navigate(RendererUrl);
        }
        finally { _initializing = false; }
    }

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        BridgeRequest? request = null;
        var locked = false;
        try
        {
            if (!ReferenceEquals(sender, _activeCore) || !string.Equals(e.Source, RendererUrl, StringComparison.Ordinal))
                throw new InvalidDataException("A message from an untrusted renderer origin was blocked.");
            request = BridgeRequest.Parse(e.WebMessageAsJson);
            if (_shuttingDown) throw new InvalidOperationException("The application is shutting down.");
            if (request.Type == "ready")
            {
                _ready = true;
                Browser.Visibility = Visibility.Visible;
                StatusPanel.Visibility = Visibility.Collapsed;
                await PublishStateAsync();
                foreach (var runtime in _runtimes.Values)
                    if (runtime.Pending is not null) await SendOutputAsync(runtime);
                ScheduleSave();
                await ReplyAsync(request);
                return;
            }
            if (!_ready) throw new InvalidOperationException("The terminal renderer is unavailable. Reload or stop sessions.");
            if (request.Type == "outputAck")
            {
                var runtime = CurrentRuntime(request);
                var sequence = request.Read<OutputAck>().Sequence;
                if (sequence <= 0) throw new InvalidDataException("Output acknowledgement sequences must be positive.");
                if (runtime.Pending is not null && runtime.Pending.Sequence == sequence)
                {
                    runtime.LastAcknowledged = sequence;
                    runtime.Pending.Acknowledged.TrySetResult();
                }
                else if (sequence > runtime.LastAcknowledged)
                    throw new InvalidDataException("The output acknowledgement does not match the outstanding batch.");
                return;
            }
            if (request.Type is "input" or "resize")
            {
                var runtime = CurrentRuntime(request, requireRunning: true);
                var (_, pane) = WorkspaceCommands.FindPane(_document.Workspace, runtime.PaneId);
                if (request.Type == "input")
                {
                    if (pane.ReadOnly) throw new InvalidOperationException("This pane is read-only. No input was sent.");
                    await runtime.Session!.WriteAsync(request.Read<TerminalInput>().Text);
                }
                else
                {
                    var size = request.Read<TerminalSize>();
                    runtime.Session!.Resize(size.Columns, size.Rows);
                }
                await ReplyAsync(request);
                return;
            }
            await _commands.WaitAsync();
            locked = true;
            if (_shuttingDown) throw new InvalidOperationException("The application is shutting down.");
            var completed = await ExecuteAsync(request);
            await ReplyAsync(request, cancelled: !completed);
        }
        catch (Exception error)
        {
            if (request is not null) await ReplyAsync(request, error: error.Message);
            else await ReportErrorAsync(error.Message);
        }
        finally { if (locked) _commands.Release(); }
    }

    private async Task<bool> ExecuteAsync(BridgeRequest request)
    {
        switch (request.Type)
        {
            case "startPane":
            case "resumePane":
            case "restartPane":
            {
                var (_, pane) = WorkspaceCommands.FindPane(_document.Workspace, request.Read<PaneReference>().PaneId);
                if (request.Type == "restartPane" && _runtimes.TryGetValue(pane.Id, out var current) && IsBusy(current))
                {
                    if (!Confirm("Restart session", $"Stop the process tree for {pane.Name} and start a new process?\n\n" +
                            "Use Interrupt first if the agent needs a chance to finish safely.", "Stop and restart")) return false;
                    await StopRuntimeAsync(current);
                }
                return await QueueStartsAsync([pane], request.Type == "resumePane");
            }
            case "startWorkspace":
            {
                var tab = WorkspaceCommands.FindTab(_document.Workspace, request.Read<TabReference>().TabId);
                var panes = tab.Panes.Where(p => !_runtimes.TryGetValue(p.Id, out var runtime) || !IsBusy(runtime)).ToArray();
                if (panes.Length == 0) throw new InvalidOperationException("There are no stopped panes to start in this workspace.");
                return await QueueStartsAsync(panes, false);
            }
            case "interrupt":
            {
                var runtime = RuntimeForPane(request.Read<PaneReference>().PaneId);
                if (WorkspaceCommands.FindPane(_document.Workspace, runtime.PaneId).Pane.ReadOnly)
                    throw new InvalidOperationException("Disable read-only mode before sending an interrupt.");
                await runtime.Session!.WriteAsync("\x03");
                return true;
            }
            case "stopPane":
            {
                var id = request.Read<PaneReference>().PaneId;
                var (_, pane) = WorkspaceCommands.FindPane(_document.Workspace, id);
                if (!_runtimes.TryGetValue(id, out var runtime) || !IsBusy(runtime))
                    throw new InvalidOperationException("This pane has no live or queued session.");
                if (!Confirm("Stop session", $"Forcibly stop the process tree for {pane.Name}?\n\n" +
                        "Interrupt with Ctrl+C first if appropriate. Other panes are not affected.", "Stop session")) return false;
                await StopRuntimeAsync(runtime);
                return true;
            }
            case "closePane":
            case "closeTab":
            {
                var ids = request.Type == "closePane"
                    ? new[] { request.Read<PaneReference>().PaneId }
                    : WorkspaceCommands.FindTab(_document.Workspace, request.Read<TabReference>().TabId).Panes.Select(p => p.Id).ToArray();
                var busy = ids.Select(id => _runtimes.GetValueOrDefault(id)).OfType<PaneRuntime>().Where(IsBusy).ToArray();
                if (busy.Length > 0 && !Confirm("Close sessions",
                        $"Closing this {(request.Type == "closePane" ? "pane" : "tab")} stops {busy.Length} live or queued session(s).\n\n" +
                        "Use Interrupt first if appropriate. Only their owned process trees will be stopped.", "Close and stop")) return false;
                await Task.WhenAll(busy.Select(StopRuntimeAsync));
                foreach (var id in ids) _runtimes.Remove(id);
                Commit(request);
                await PublishStateAsync();
                return true;
            }
            case "maximize":
            {
                var (tab, pane) = WorkspaceCommands.FindPane(_document.Workspace, request.Read<PaneReference>().PaneId);
                if (_maximized.GetValueOrDefault(tab.Id) == pane.Id) _maximized.Remove(tab.Id);
                else _maximized[tab.Id] = pane.Id;
                await PublishStateAsync();
                return true;
            }
            case "clearView":
            {
                var id = request.Read<PaneReference>().PaneId;
                WorkspaceCommands.FindPane(_document.Workspace, id);
                await PostAsync(new { type = "clear", paneId = id });
                return true;
            }
            case "copy":
            {
                var text = request.Read<TextPayload>().Text;
                if (text.Length > 1_048_576) throw new InvalidDataException("Clipboard text exceeds 1 MiB.");
                if (text.Length > 0) Clipboard.SetText(text);
                return true;
            }
            case "paste":
            case "pasteText":
            {
                var runtime = CurrentRuntime(request, requireRunning: true);
                if (WorkspaceCommands.FindPane(_document.Workspace, runtime.PaneId).Pane.ReadOnly)
                    throw new InvalidOperationException("This pane is read-only. Nothing was pasted.");
                var text = request.Type == "paste" ? Clipboard.GetText() : request.Read<TextPayload>().Text;
                if (text.Length > 1_048_576) throw new InvalidDataException("Paste exceeds 1 MiB.");
                if (text.IndexOfAny(['\r', '\n']) >= 0 && !Confirm("Confirm multiline paste",
                        "Multiline text can execute commands, depending on the shell's bracketed-paste support.\n\n" + text, "Paste text")) return false;
                await PostAsync(new { type = "paste", paneId = runtime.PaneId, generation = runtime.Generation, text });
                return true;
            }
            case "broadcast":
                return await BroadcastAsync(request.Read<BroadcastInput>());
            case "save":
                return await SaveExplicitlyAsync();
            case "recover":
                return await RestoreBackupAsync();
            case "import":
                return await ImportAsync();
            case "export":
                return await ExportAsync(request.Read<ExportOptions>().IncludeScripts);
            case "transcript":
                return await ExportTranscriptAsync(request);
            case "worktree":
                return await CreateWorktreeAsync(request.Read<WorktreeOptions>());
            case "openLink":
            {
                var url = request.Read<LinkOptions>().Url;
                if (url.Length > 8192 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length > 0)
                    throw new InvalidDataException("Only HTTPS links without embedded credentials may open externally.");
                if (!Confirm("Open external link", uri.AbsoluteUri, "Open in browser")) return false;
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
                return true;
            }
            case "rendererError":
                ShowRendererFailure("Terminal renderer error", request.Read<TextPayload>().Text +
                    "\n\nSessions remain owned by this application. Reloading loses the previous display, but does not restart processes.");
                return true;
            default:
                Commit(request);
                if (request.Type is "selectTab" or "focusPane") _unread.Remove(_document.Workspace.ActiveTabId);
                ApplyHostTheme();
                await PublishStateAsync();
                return true;
        }
    }

    private void Commit(BridgeRequest request)
    {
        _document = WorkspaceCommands.Apply(_document, request);
        foreach (var tabId in _maximized.Keys.ToArray())
            if (!_document.Workspace.Tabs.Any(t => t.Id == tabId && t.Panes.Any(p => p.Id == _maximized[tabId])))
                _maximized.Remove(tabId);
        ScheduleSave();
    }

    private async Task<bool> QueueStartsAsync(PaneDefinition[] panes, bool resume)
    {
        var launches = new List<(PaneDefinition Pane, LaunchProfile Profile, string? Error)>();
        foreach (var pane in panes)
        {
            if (_runtimes.TryGetValue(pane.Id, out var runtime) && IsBusy(runtime))
                throw new InvalidOperationException($"{pane.Name} already has a live or queued session.");
            var profile = WorkspaceJson.Clone(pane.Profile);
            string? error = null;
            try
            {
                if (resume)
                {
                    if (string.IsNullOrWhiteSpace(profile.ResumeScript)) throw new InvalidDataException("No agent resume command is configured.");
                    profile.StartupScript = profile.ResumeScript;
                }
                var launch = await Task.Run(() => ShellLauncher.Build(profile, pane.Id));
                profile.Executable = launch.Executable;
                profile.WorkingDirectory = launch.WorkingDirectory;
            }
            catch (Exception exception) when (exception is IOException or InvalidDataException or UnauthorizedAccessException or Win32Exception or ArgumentException or NotSupportedException)
            {
                error = exception.Message;
            }
            launches.Add((pane, profile, error));
        }
        var preview = new StringBuilder("Review executable code before starting. Sessions use your Windows permissions; they are not sandboxes.\n");
        foreach (var (pane, profile, error) in launches)
        {
            preview.AppendLine($"\n--- {pane.Name} ---\nShell: {profile.Executable}\nInitial directory: {profile.WorkingDirectory}");
            if (error is not null) preview.AppendLine("WILL NOT START - validation failed: " + error);
            preview.AppendLine($"User profile: {(profile.LoadUserProfile ? "loaded (also executes code)" : "not loaded")}; keep open: {profile.KeepShellOpen}");
            if (pane.Plan.NotBefore is { } time) preview.AppendLine($"Not before: {time.ToLocalTime():g}");
            if (pane.Plan.AfterPaneId is { } dependency)
                preview.AppendLine("Requires a new explicit completed signal from: " + WorkspaceCommands.FindPane(_document.Workspace, dependency).Pane.Name);
            preview.AppendLine("Environment overrides: " + (profile.Environment.Count == 0 ? "(none)" : ""));
            foreach (var pair in profile.Environment) preview.AppendLine($"  {pair.Key}={pair.Value}");
            preview.AppendLine("Startup script:\n" + (profile.StartupScript.Length == 0 ? "(interactive prompt)" : profile.StartupScript));
        }
        if (!Confirm($"Start {panes.Length} session(s)", preview.ToString(), "Start reviewed sessions")) return false;
        if (_shuttingDown) throw new InvalidOperationException("The application is shutting down.");
        foreach (var (pane, profile, error) in launches)
        {
            if (_runtimes.TryGetValue(pane.Id, out var previous)) await StopRuntimeAsync(previous);
            var generation = _generations.GetValueOrDefault(pane.Id) + 1;
            _generations[pane.Id] = generation;
            _runtimes[pane.Id] = new PaneRuntime(pane.Id, generation, profile, WorkspaceJson.Clone(pane.Plan))
            {
                State = error is null ? "queued" : "failed",
                Error = error
            };
        }
        var launchIds = launches.Select(launch => launch.Pane.Id).ToHashSet();
        foreach (var (pane, _, _) in launches)
        {
            var runtime = _runtimes[pane.Id];
            if (runtime.Plan.AfterPaneId is { } dependency)
                runtime.DependencyGeneration = _runtimes.TryGetValue(dependency, out var prerequisite) &&
                                               (IsBusy(prerequisite) || launchIds.Contains(dependency))
                    ? prerequisite.Generation : _generations.GetValueOrDefault(dependency) + 1;
        }
        await PublishStateAsync();
        if (launches.All(launch => launch.Error is not null))
            throw new InvalidOperationException("No sessions started. Launch errors are shown on the affected panes.");
        return true;
    }

    private async Task CheckLaunchQueueAsync()
    {
        if (_checkingQueue || _shuttingDown || !_ready) return;
        _checkingQueue = true;
        try
        {
            foreach (var runtime in _runtimes.Values.Where(r => r.State == "queued").ToArray())
            {
                if (_shuttingDown || !_ready) break;
                if (runtime.State != "queued" || runtime.StopRequested) continue;
                if (runtime.Plan.AfterPaneId is { } dependency)
                {
                    var prerequisite = _runtimes.GetValueOrDefault(dependency);
                    var missing = !_document.Workspace.Tabs.Any(t => t.Panes.Any(p => p.Id == dependency));
                    var replaced = prerequisite is not null && prerequisite.Generation > runtime.DependencyGeneration;
                    var ended = prerequisite is not null && prerequisite.Generation == runtime.DependencyGeneration &&
                                prerequisite.State is "exited" or "failed" && prerequisite.Signal != "completed";
                    if (missing || replaced || ended)
                    {
                        runtime.State = "failed";
                        runtime.Error = "The prerequisite pane was removed, ended, or changed session without the expected completed signal. " +
                                        "Review and start this pane again to re-arm its dependency.";
                        await PublishStateAsync();
                        continue;
                    }
                    if (prerequisite is null || prerequisite.Generation != runtime.DependencyGeneration || prerequisite.Signal != "completed") continue;
                }
                if (runtime.Plan.NotBefore > DateTimeOffset.UtcNow) continue;
                runtime.LaunchTask = LaunchAsync(runtime);
                await runtime.LaunchTask;
            }
        }
        finally { _checkingQueue = false; }
    }

    private async Task LaunchAsync(PaneRuntime runtime)
    {
        runtime.State = "starting";
        await PublishStateAsync();
        try
        {
            runtime.Listener = new SessionSignalListener(
                signal => Dispatcher.InvokeAsync(() => OnSignalAsync(runtime, signal)).Task.Unwrap(),
                message => Dispatcher.InvokeAsync(() => ReportErrorAsync("Shell integration: " + message)).Task.Unwrap());
            runtime.Session = await ConPtySession.StartAsync(runtime.Profile, runtime.PaneId, runtime.Listener.PipeName);
            if (runtime.StopRequested || _shuttingDown)
            {
                await runtime.Session.DisposeAsync();
                runtime.State = "exited";
                runtime.ExitCode = await runtime.Session.Completion;
                await runtime.Listener.DisposeAsync();
            }
            else
            {
                runtime.State = "running";
                runtime.ProcessId = runtime.Session.ProcessId;
                await PublishStateAsync();
                runtime.PumpTask = PumpOutputAsync(runtime);
                runtime.CompletionTask = ObserveExitAsync(runtime);
            }
        }
        catch (Exception error)
        {
            runtime.State = "failed";
            runtime.Error = error.Message;
            if (runtime.Listener is not null) await runtime.Listener.DisposeAsync();
            if (runtime.Session is not null) await runtime.Session.DisposeAsync();
        }
        await PublishStateAsync();
    }

    private async Task PumpOutputAsync(PaneRuntime runtime)
    {
        try
        {
            await foreach (var text in runtime.Session!.Output.ReadAllAsync(runtime.Stop.Token))
            {
                runtime.Pending = new PendingOutput(++runtime.Sequence, text);
                await SendOutputAsync(runtime);
                await runtime.Pending.Acknowledged.Task.WaitAsync(runtime.Stop.Token);
                runtime.Pending = null;
                var (tab, _) = WorkspaceCommands.FindPane(_document.Workspace, runtime.PaneId);
                if (tab.Id != _document.Workspace.ActiveTabId && _unread.Add(tab.Id))
                    await PostAsync(new { type = "unread", tabId = tab.Id });
            }
        }
        catch (OperationCanceledException) when (runtime.Stop.IsCancellationRequested) { }
    }

    private async Task SendOutputAsync(PaneRuntime runtime)
    {
        if (!_ready || runtime.Pending is not { } batch) return;
        try
        {
            await PostAsync(new
            {
                type = "output", paneId = runtime.PaneId, generation = runtime.Generation,
                sequence = batch.Sequence, text = batch.Text
            });
        }
        catch (Exception error) when (error is COMException or InvalidOperationException)
        {
            ShowRendererFailure("Terminal output view unavailable", error.Message +
                "\n\nOutput is paused without dropping the pending batch. Reload the views or stop sessions.");
        }
    }

    private async Task ObserveExitAsync(PaneRuntime runtime)
    {
        try
        {
            runtime.ExitCode = await runtime.Session!.Completion;
            await runtime.PumpTask;
            runtime.State = "exited";
        }
        catch (Exception error)
        {
            runtime.State = "failed";
            runtime.Error = error.Message;
        }
        finally
        {
            try
            {
                if (runtime.Listener is not null) await runtime.Listener.DisposeAsync();
                if (runtime.Session is not null) await runtime.Session.DisposeAsync();
            }
            catch (Exception error)
            {
                runtime.State = "failed";
                runtime.Error = "Session cleanup failed: " + error.Message;
            }
        }
        await PublishStateAsync();
    }

    private async Task StopRuntimeAsync(PaneRuntime runtime)
    {
        runtime.StopRequested = true;
        runtime.Stop.Cancel();
        if (runtime.State == "queued") runtime.State = "exited";
        else if (runtime.LaunchTask is { IsCompleted: false }) await runtime.LaunchTask;
        if (runtime.Session is not null)
        {
            runtime.State = "stopping";
            await PublishStateAsync();
            await runtime.Session.DisposeAsync();
            await runtime.PumpTask;
            await runtime.CompletionTask;
        }
        runtime.State = runtime.Error is null ? "exited" : "failed";
        await PublishStateAsync();
    }

    private async Task OnSignalAsync(PaneRuntime runtime, AgentSignal signal)
    {
        if (!_runtimes.TryGetValue(runtime.PaneId, out var current) || current != runtime || runtime.StopRequested) return;
        if (signal.State == "directory")
        {
            if (!Path.IsPathFullyQualified(signal.Message) || !Directory.Exists(signal.Message))
                throw new InvalidDataException("The shell reported an invalid current directory.");
            runtime.Directory = signal.Message;
            try { runtime.Branch = await GitWorktreeService.BranchAsync(signal.Message); }
            catch (IOException error) { runtime.Branch = "Git unavailable: " + error.Message; }
        }
        else
        {
            runtime.Signal = signal.State;
            runtime.SignalMessage = signal.Message;
            if (signal.State is "waiting" or "completed")
            {
                var (tab, pane) = WorkspaceCommands.FindPane(_document.Workspace, runtime.PaneId);
                if (tab.Id != _document.Workspace.ActiveTabId) _unread.Add(tab.Id);
                await PostAsync(new { type = "notice", message = $"{pane.Name}: integration reports {signal.State}. {signal.Message}", error = false });
            }
        }
        await PublishStateAsync();
    }

    private async Task<bool> BroadcastAsync(BroadcastInput options)
    {
        if (options.Recipients.Length == 0 || options.Recipients.Length > 200 || options.Text.Length is 0 or > 1_048_576)
            throw new InvalidDataException("Select recipients and supply between 1 and 1,048,576 characters.");
        if (options.Recipients.Select(r => r.PaneId).Distinct().Count() != options.Recipients.Length)
            throw new InvalidDataException("Broadcast recipients must be distinct.");
        var targets = options.Recipients.Select(recipient =>
        {
            var runtime = RuntimeForPane(recipient.PaneId);
            var (_, pane) = WorkspaceCommands.FindPane(_document.Workspace, recipient.PaneId);
            if (runtime.Generation != recipient.Generation || pane.ReadOnly)
                throw new InvalidOperationException("A broadcast recipient changed session or became read-only. Nothing was sent.");
            return (Runtime: runtime, Pane: pane);
        }).ToArray();
        if (!Confirm("Broadcast terminal input",
                $"Send to {targets.Length} explicitly selected session(s):\n{string.Join("\n", targets.Select(t => t.Pane.Name))}\n\n" +
                $"Append Enter: {options.Submit}\n\nThis text may execute commands:\n{options.Text}", "Send to selected sessions")) return false;
        foreach (var target in targets)
            await target.Runtime.Session!.WriteAsync(options.Text.Replace("\r\n", "\n").Replace('\n', '\r') + (options.Submit ? "\r" : ""));
        return true;
    }

    private async void OnTimer(object? sender, EventArgs e)
    {
        try
        {
            await CheckLaunchQueueAsync();
            if (++_ticks % 2 != 0 || !_ready) return;
            var metrics = new List<object>();
            foreach (var runtime in _runtimes.Values.Where(r => r.State == "running"))
            {
                var sample = runtime.Session?.SampleMetrics();
                if (sample is not null) metrics.Add(new { paneId = runtime.PaneId, cpu = sample.CpuPercent, memory = sample.WorkingSetBytes });
            }
            await PostAsync(new { type = "metrics", items = metrics });
        }
        catch (Exception error) { await ReportErrorAsync(error.Message); }
    }

    private void ScheduleSave()
    {
        if (!_persistenceEnabled || _shuttingDown) return;
        _saveDelay?.Cancel();
        _saveDelay?.Dispose();
        _saveDelay = new CancellationTokenSource();
        _saveStatus = "Saving...";
        _saveTask = SaveAfterDelayAsync(WorkspaceJson.Clone(_document), _saveDelay.Token);
    }

    private async Task SaveAfterDelayAsync(ApplicationDocument snapshot, CancellationToken token)
    {
        try
        {
            await Task.Delay(400, token);
            await _store.SaveAsync(snapshot, token);
            _saveStatus = "Saved locally";
            await PostAsync(new { type = "saveStatus", text = _saveStatus });
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            _saveStatus = "Save failed - use Save to retry";
            await PostAsync(new { type = "saveStatus", text = _saveStatus });
            await ReportErrorAsync("Workspace was not saved: " + error.Message);
        }
    }

    private async Task<bool> SaveExplicitlyAsync()
    {
        if (!_persistenceEnabled)
        {
            if (!Confirm("Replace invalid configuration", "Retain the original configuration as a separate recovery file, " +
                    "then save the current workspace in its place?\n\n" + _store.Path, "Retain original and save")) return false;
            PreserveOriginal();
            _persistenceEnabled = true;
        }
        _saveDelay?.Cancel();
        await _saveTask;
        await _store.SaveAsync(_document);
        _saveStatus = "Saved locally";
        await PublishStateAsync();
        return true;
    }

    private async Task<bool> RestoreBackupAsync()
    {
        var restored = await WorkspaceStore.ReadAsync<ApplicationDocument>(_store.BackupPath);
        WorkspaceValidator.Validate(restored);
        if (!Confirm("Restore backup", "Restore the last saved backup? Its sessions will be not started.\n\n" +
                $"This stops {BusyCount} live or queued session(s). The current configuration file will be retained.", "Restore backup")) return false;
        await StopAllAsync();
        _saveDelay?.Cancel();
        await _saveTask;
        PreserveOriginal();
        await _store.SaveAsync(restored);
        _document = restored;
        _persistenceEnabled = true;
        _saveStatus = "Backup restored - sessions not started";
        _runtimes.Clear();
        _maximized.Clear();
        _unread.Clear();
        ApplyHostTheme();
        await PublishStateAsync();
        return true;
    }

    private void PreserveOriginal()
    {
        if (File.Exists(_store.Path))
            File.Move(_store.Path, _store.Path + ".recovered-" + DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N") + ".json");
    }

    private async Task<bool> ImportAsync()
    {
        var dialog = new OpenFileDialog { Title = "Open workspace layout", Filter = "Workspace JSON (*.json)|*.json" };
        if (dialog.ShowDialog(this) != true) return false;
        var workspace = await WorkspaceStore.ReadAsync<WorkspaceDocument>(dialog.FileName);
        WorkspaceValidator.Validate(workspace);
        if (!Confirm("Open unstarted workspace",
                $"Open {workspace.Tabs.Count} tab(s) and {workspace.Tabs.Sum(t => t.Panes.Count)} pane(s)?\n\n" +
                $"This stops {BusyCount} live or queued session(s) in the current workspace.\n" +
                "Imported scripts and environment values are executable/sensitive configuration. No scripts will run until you review and start sessions.", "Open layout")) return false;
        await StopAllAsync();
        _runtimes.Clear();
        _maximized.Clear();
        _unread.Clear();
        _document.Workspace = workspace;
        ScheduleSave();
        await PublishStateAsync();
        return true;
    }

    private async Task<bool> ExportAsync(bool includeScripts)
    {
        if (includeScripts && !Confirm("Export executable configuration",
                "Startup/resume scripts and environment overrides may contain secrets. Export them only to a trusted location.", "Export with scripts")) return false;
        var dialog = new SaveFileDialog { Title = "Export workspace layout", Filter = "Workspace JSON (*.json)|*.json", FileName = "workspace.json" };
        if (dialog.ShowDialog(this) != true) return false;
        var workspace = WorkspaceStore.Export(_document.Workspace, includeScripts);
        await File.WriteAllTextAsync(dialog.FileName, JsonSerializer.Serialize(workspace, WorkspaceJson.Options));
        return true;
    }

    private async Task<bool> ExportTranscriptAsync(BridgeRequest request)
    {
        var runtime = CurrentRuntime(request);
        var text = request.Read<TextPayload>().Text;
        if (Encoding.UTF8.GetByteCount(text) > WorkspaceStore.MaximumDocumentBytes)
            throw new InvalidDataException("Transcript exceeds the 10 MiB export limit.");
        if (!Confirm("Export terminal transcript", "Terminal transcripts can contain credentials and private output. " +
                "Export is opt-in; no terminal transcript is saved automatically.", "Choose export file")) return false;
        var dialog = new SaveFileDialog { Title = "Export transcript", Filter = "Text (*.txt)|*.txt", FileName = $"terminal-{runtime.PaneId.ToString()[..8]}.txt" };
        if (dialog.ShowDialog(this) != true) return false;
        await File.WriteAllTextAsync(dialog.FileName, text);
        return true;
    }

    private async Task<bool> CreateWorktreeAsync(WorktreeOptions options)
    {
        var (_, pane) = WorkspaceCommands.FindPane(_document.Workspace, options.PaneId);
        if (!Confirm("Create Git worktree", $"Repository: {options.Repository}\nNew directory: {options.Destination}\nNew branch: {options.Branch}\n\n" +
                "Git may execute configured checkout hooks. This creates a branch and worktree, but never deletes existing or dirty worktrees. " +
                "The pane's directory changes for future launches only.", "Create worktree")) return false;
        var directory = await GitWorktreeService.CreateAsync(options.Repository, options.Destination, options.Branch);
        pane.Profile.WorkingDirectory = directory;
        ScheduleSave();
        await PublishStateAsync();
        return true;
    }

    private PaneRuntime CurrentRuntime(BridgeRequest request, bool requireRunning = false)
    {
        if (request.PaneId is not { } id || !_runtimes.TryGetValue(id, out var runtime) || request.Generation != runtime.Generation)
            throw new InvalidOperationException("The session changed. Stale input/output messages were rejected.");
        WorkspaceCommands.FindPane(_document.Workspace, id);
        if (requireRunning && (runtime.State != "running" || runtime.Session?.IsRunning != true))
            throw new InvalidOperationException("The PowerShell session is not running.");
        return runtime;
    }

    private PaneRuntime RuntimeForPane(Guid id)
    {
        if (!_runtimes.TryGetValue(id, out var runtime) || runtime.State != "running" || runtime.Session?.IsRunning != true)
            throw new InvalidOperationException("The PowerShell session is not running.");
        return runtime;
    }

    private static bool IsBusy(PaneRuntime runtime) => runtime.State is "queued" or "starting" or "running" or "stopping";
    private int BusyCount => _runtimes.Values.Count(IsBusy);
    private bool Confirm(string title, string text, string accept) => ReviewDialog.Confirm(this, title, text, _dark, accept);

    private Task PublishStateAsync() => PostAsync(new
    {
        type = "state", document = _document, resolvedTheme = _dark ? "dark" : "light",
        runtimes = _runtimes.Values.Select(r => new
        {
            paneId = r.PaneId, generation = r.Generation, state = r.State, processId = r.ProcessId,
            exitCode = r.ExitCode, error = r.Error, signal = r.Signal, signalMessage = r.SignalMessage,
            directory = r.Directory ?? r.Profile.WorkingDirectory, directoryIsLive = r.Directory is not null,
            branch = r.Branch, executable = r.Profile.Executable,
            notBefore = r.Plan.NotBefore, afterPaneId = r.Plan.AfterPaneId, dependencyGeneration = r.DependencyGeneration
        }).ToArray(),
        maximized = _maximized, unreadTabs = _unread.ToArray(), saveStatus = _saveStatus,
        autosaveEnabled = _persistenceEnabled
    });

    private Task ReplyAsync(BridgeRequest request, string? error = null, bool cancelled = false) =>
        PostAsync(new { type = "result", id = request.Id, ok = error is null, cancelled, error });

    private Task ReportErrorAsync(string message)
    {
        if (!_ready)
        {
            StatusDetail.Text = message;
            return Task.CompletedTask;
        }
        return PostAsync(new { type = "notice", message, error = true });
    }

    private Task PostAsync(object message)
    {
        if (_ready) _activeCore!.PostWebMessageAsJson(JsonSerializer.Serialize(message, WorkspaceJson.Options));
        return Task.CompletedTask;
    }

    private void ApplyHostTheme()
    {
        _dark = _document.Settings.Theme switch
        {
            ThemePreference.Dark => true,
            ThemePreference.Light => false,
            _ => Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "AppsUseLightTheme", 1) is int value && value == 0
        };
        var background = _dark ? Color.FromRgb(11, 16, 32) : Colors.White;
        Background = new SolidColorBrush(background);
        StatusPanel.Background = new SolidColorBrush(background);
        StatusTitle.Foreground = new SolidColorBrush(_dark ? Color.FromRgb(232, 237, 247) : Color.FromRgb(23, 34, 54));
        StatusDetail.Foreground = new SolidColorBrush(_dark ? Color.FromRgb(170, 180, 200) : Color.FromRgb(82, 97, 118));
        Browser.DefaultBackgroundColor = System.Drawing.Color.FromArgb(background.R, background.G, background.B);
        foreach (var button in new[] { RetryButton, StopButton })
        {
            button.Background = new SolidColorBrush(_dark ? Color.FromRgb(27, 37, 59) : Color.FromRgb(237, 240, 247));
            button.Foreground = StatusTitle.Foreground;
            button.BorderBrush = new SolidColorBrush(_dark ? Color.FromRgb(53, 66, 92) : Color.FromRgb(189, 199, 215));
        }
        ReviewDialog.ApplyWindowTheme(this, _dark);
    }

    private void OnSystemAppearanceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        Dispatcher.InvokeAsync(async () =>
        {
            try
            {
                if (_shuttingDown || _document.Settings.Theme != ThemePreference.System) return;
                ApplyHostTheme();
                await PublishStateAsync();
            }
            catch (Exception error) { await ReportErrorAsync("Windows appearance could not be applied: " + error.Message); }
        });
    }

    private void ShowRendererFailure(string title, string detail)
    {
        _ready = false;
        Browser.Visibility = Visibility.Hidden;
        StatusTitle.Text = title;
        StatusDetail.Text = detail;
        StatusPanel.Visibility = Visibility.Visible;
        RetryButton.Visibility = Visibility.Visible;
        StopButton.Visibility = BusyCount > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnRetryRenderer(object sender, RoutedEventArgs e)
    {
        try
        {
            RetryButton.IsEnabled = false;
            if (BusyCount > 0 && !Confirm("Recreate terminal views",
                    "Existing processes continue, but the previous terminal screen/history cannot be restored. Pending output will resume in fresh views.", "Reload views")) return;
            if (_recreateBrowser || _activeCore is null)
            {
                _ready = false;
                _activeCore = null;
                HostGrid.Children.Remove(Browser);
                Browser.Dispose();
                Browser = new Microsoft.Web.WebView2.Wpf.WebView2 { Visibility = Visibility.Hidden };
                HostGrid.Children.Insert(0, Browser);
                ApplyHostTheme();
                await InitializeRendererAsync();
            }
            else _activeCore.Reload();
            _timer.Start();
        }
        catch (Exception error) { ShowRendererFailure("Renderer recovery failed", error.Message); }
        finally { RetryButton.IsEnabled = true; }
    }

    private async void OnStopSessions(object sender, RoutedEventArgs e)
    {
        try
        {
            if (Confirm("Stop all sessions", $"Forcibly stop {BusyCount} live or queued session(s)?", "Stop all"))
            {
                await StopAllAsync();
                StopButton.Visibility = Visibility.Collapsed;
                StatusDetail.Text += "\n\nAll owned sessions have been stopped.";
            }
        }
        catch (Exception error) { StatusDetail.Text = "Stopping sessions failed: " + error.Message; }
    }

    private Task StopAllAsync() => Task.WhenAll(_runtimes.Values.Where(IsBusy).ToArray().Select(StopRuntimeAsync));

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        if (_shuttingDown) return;
        if (BusyCount > 0 && !Confirm("Close Prompt Terminal",
                $"Closing stops {BusyCount} live or queued session(s) and their owned process trees.\n\n" +
                "Use Interrupt first if an agent needs a chance to finish. Cancel leaves all sessions running.", "Close and stop")) return;
        _shuttingDown = true;
        _timer.Stop();
        try
        {
            await StopAllAsync();
            _saveDelay?.Cancel();
            await _saveTask;
            if (_persistenceEnabled) await _store.SaveAsync(_document);
            SystemEvents.UserPreferenceChanged -= OnSystemAppearanceChanged;
            _ready = false;
            _activeCore = null;
            Browser.Dispose();
            _allowClose = true;
            Close();
        }
        catch (Exception error)
        {
            _shuttingDown = false;
            _timer.Start();
            MessageBox.Show(this, "The application was not closed:\n" + error.Message,
                "Shutdown failed", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private sealed class PaneRuntime(Guid paneId, long generation, LaunchProfile profile, LaunchPlan plan)
    {
        public Guid PaneId { get; } = paneId;
        public long Generation { get; } = generation;
        public LaunchProfile Profile { get; } = profile;
        public LaunchPlan Plan { get; } = plan;
        public string State { get; set; } = "queued";
        public int? ProcessId { get; set; }
        public int? ExitCode { get; set; }
        public string? Error { get; set; }
        public string? Signal { get; set; }
        public string? SignalMessage { get; set; }
        public string? Directory { get; set; }
        public string? Branch { get; set; }
        public long DependencyGeneration { get; set; }
        public bool StopRequested { get; set; }
        public CancellationTokenSource Stop { get; } = new();
        public ConPtySession? Session { get; set; }
        public SessionSignalListener? Listener { get; set; }
        public Task LaunchTask { get; set; } = Task.CompletedTask;
        public Task PumpTask { get; set; } = Task.CompletedTask;
        public Task CompletionTask { get; set; } = Task.CompletedTask;
        public PendingOutput? Pending { get; set; }
        public long Sequence { get; set; }
        public long LastAcknowledged { get; set; }
    }

    private sealed record PendingOutput(long Sequence, string Text)
    {
        public TaskCompletionSource Acknowledged { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed record OutputAck(long Sequence);
    private sealed record TerminalInput(string Text);
    private sealed record TerminalSize(int Columns, int Rows);
    private sealed record TextPayload(string Text);
    private sealed record ExportOptions(bool IncludeScripts);
    private sealed record LinkOptions(string Url);
    private sealed record WorktreeOptions(Guid PaneId, string Repository, string Destination, string Branch);
    private sealed record BroadcastRecipient(Guid PaneId, long Generation);
    private sealed record BroadcastInput(BroadcastRecipient[] Recipients, string Text, bool Submit);
}
