using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Terminal;

namespace PromptTerminal.Tests;

[SupportedOSPlatform("windows")]
public sealed class TerminalTests
{
    private static LaunchProfile Profile(string script, bool keepOpen = false) => new()
    {
        Executable = ShellLauncher.FindDefaultShell(),
        LoadUserProfile = false,
        EnableIntegration = false,
        KeepShellOpen = keepOpen,
        StartupScript = script
    };

    private static async Task<(int ExitCode, string Output)> RunAsync(LaunchProfile profile)
    {
        await using var session = await ConPtySession.StartAsync(profile, Guid.NewGuid());
        var output = new StringBuilder();
        var reader = Task.Run(async () =>
        {
            await foreach (var text in session.Output.ReadAllAsync()) output.Append(text);
        });
        var exit = await session.Completion.WaitAsync(TimeSpan.FromSeconds(30));
        await reader.WaitAsync(TimeSpan.FromSeconds(10));
        return (exit, output.ToString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunsStartupExactlyOnceWithCorrectExitCode(bool windowsPowerShell)
    {
        var profile = Profile("[Console]::WriteLine('startup-once-73'); exit 23");
        if (windowsPowerShell)
            profile.Executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
        var result = await RunAsync(profile);
        Assert.Equal(23, result.ExitCode);
        Assert.Single(Regex.Matches(result.Output, "startup-once-73"));
    }

    [Fact]
    public async Task PreservesMultilineUnicodeAndLargeScriptWithoutCommandLineQuoting()
    {
        var script = "# " + new string('x', 30_000) + "\n[Console]::WriteLine('quoted \"value\" \u03bb \u4e2d');\n[Console]::WriteLine('second-line')";
        var result = await RunAsync(Profile(script));
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("quoted \"value\" \u03bb \u4e2d", result.Output);
        Assert.Contains("second-line", result.Output);
    }

    [Fact]
    public async Task IndependentSessionsHaveDistinctProcessesDirectoriesAndEnvironments()
    {
        var directory = Path.Combine(Path.GetTempPath(), "PromptTerminal space \u03bb " + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var first = Profile("[Console]::WriteLine($PWD.Path); [Console]::WriteLine($env:PT_TEST_VALUE)");
            first.WorkingDirectory = directory;
            first.Environment["PT_TEST_VALUE"] = "first-isolated";
            var second = Profile("[Console]::WriteLine($env:PT_TEST_VALUE)");
            second.Environment["PT_TEST_VALUE"] = "second-isolated";
            var results = await Task.WhenAll(RunAsync(first), RunAsync(second));
            Assert.Contains(directory, results[0].Output);
            Assert.Contains("first-isolated", results[0].Output);
            Assert.DoesNotContain("second-isolated", results[0].Output);
            Assert.Contains("second-isolated", results[1].Output);
            Assert.Null(Environment.GetEnvironmentVariable("PT_TEST_VALUE"));
        }
        finally { Directory.Delete(directory); }
    }

    [Fact]
    public async Task ResizesTheActualConsoleDimensions()
    {
        await using var session = await ConPtySession.StartAsync(
            Profile("Start-Sleep -Milliseconds 500; [Console]::WriteLine(('SIZE:{0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight))"), Guid.NewGuid());
        var output = new StringBuilder();
        var reader = Task.Run(async () =>
        {
            await foreach (var text in session.Output.ReadAllAsync()) output.Append(text);
        });
        session.Resize(132, 43);
        await session.Completion.WaitAsync(TimeSpan.FromSeconds(30));
        await reader;
        Assert.Contains("SIZE:132x43", output.ToString());
    }

    [Fact]
    public async Task StoppingSessionTerminatesItsChildButNotAnotherSession()
    {
        await using var other = await ConPtySession.StartAsync(Profile("Start-Sleep -Seconds 120"), Guid.NewGuid());
        var childId = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var output = new StringBuilder();
        var session = await ConPtySession.StartAsync(Profile("""
            [Console]::WriteLine(('PARENT:{0}' -f $PID))
            $start = [Diagnostics.ProcessStartInfo]::new(($env:SystemRoot + '\System32\cmd.exe'))
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.Arguments = '/d /c "ping -t 127.0.0.1 >nul"'
            $child = [Diagnostics.Process]::Start($start)
            [Console]::WriteLine(('CHILD:{0}' -f $child.Id))
            Start-Sleep -Seconds 120
            """), Guid.NewGuid());
        var reader = Task.Run(async () =>
        {
            await foreach (var text in session.Output.ReadAllAsync())
            {
                output.Append(text);
                var match = Regex.Match(output.ToString(), @"CHILD:(\d+)[\r\n]");
                if (match.Success) childId.TrySetResult(int.Parse(match.Groups[1].Value));
            }
        });
        Process? childProcess = null;
        try
        {
            var id = await childId.Task.WaitAsync(TimeSpan.FromSeconds(30));
            childProcess = Process.GetProcessById(id);
            Assert.True(session.ContainsProcess(session.ProcessId), "The host process is not in its assigned job.");
            Assert.Contains("PARENT:" + session.ProcessId, output.ToString());
            Assert.True(session.ContainsProcess(id), $"Child {id} is not contained; output: {output}");
            await session.DisposeAsync();
            await childProcess.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(other.IsRunning);
            Assert.NotEqual(session.ProcessId, other.ProcessId);
        }
        finally
        {
            await session.DisposeAsync();
            await reader;
            if (childProcess is not null)
            {
                if (!childProcess.HasExited) childProcess.Kill(entireProcessTree: true);
                childProcess.Dispose();
            }
        }
    }

    [Fact]
    public async Task ExplicitIntegrationSignalIsNotInferredFromOutput()
    {
        var signal = new TaskCompletionSource<AgentSignal>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var listener = new SessionSignalListener(
            item => { signal.TrySetResult(item); return Task.CompletedTask; },
            message => { signal.TrySetException(new InvalidDataException(message)); return Task.CompletedTask; });
        var profile = Profile("Send-PromptTerminalSignal -State completed -Message 'tests passed'");
        profile.EnableIntegration = true;
        await using var session = await ConPtySession.StartAsync(profile, Guid.NewGuid(), listener.PipeName);
        var drain = Task.Run(async () => { await foreach (var _ in session.Output.ReadAllAsync()) { } });
        var received = await signal.Task.WaitAsync(TimeSpan.FromSeconds(30));
        await session.Completion.WaitAsync(TimeSpan.FromSeconds(30));
        await drain;
        Assert.Equal("completed", received.State);
        Assert.Equal("tests passed", received.Message);
    }

    [Fact]
    public async Task LargeUtf8OutputRemainsValidAcrossPipeReadsAndRepaints()
    {
        var result = await RunAsync(Profile("[Console]::Write(('A\u03bb\u4e2d' * 200000)); [Console]::WriteLine('OUTPUT-DONE')"));
        Assert.Equal(0, result.ExitCode);
        // ConPTY can repaint cells; exact transcript contents are checked by the real desktop renderer test.
        Assert.True(result.Output.Count(character => character == '\u03bb') >= 200000);
        Assert.True(result.Output.Count(character => character == '\u4e2d') >= 200000);
        Assert.DoesNotContain('\ufffd', result.Output);
        Assert.Contains("OUTPUT-DONE", result.Output);
    }

    [Fact]
    public async Task InvalidIntegrationMessageIsReportedAndDoesNotStopTheListener()
    {
        var rejected = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var accepted = new TaskCompletionSource<AgentSignal>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var listener = new SessionSignalListener(
            signal => { accepted.TrySetResult(signal); return Task.CompletedTask; },
            message => { rejected.TrySetResult(message); return Task.CompletedTask; });

        async Task SendAsync(string text)
        {
            await using var client = new NamedPipeClientStream(".", listener.PipeName, PipeDirection.Out, PipeOptions.Asynchronous);
            await client.ConnectAsync(5000);
            await using var writer = new StreamWriter(client, new UTF8Encoding(false));
            await writer.WriteLineAsync(text);
        }

        await SendAsync("""{"state":"guessed","message":"invalid"}""");
        Assert.Contains("unsupported state", await rejected.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        await SendAsync("""{"state":"completed","message":"explicit"}""");
        Assert.Equal("explicit", (await accepted.Task.WaitAsync(TimeSpan.FromSeconds(10))).Message);
    }

    [Fact]
    public async Task InteractiveInputPreservesUnicodeThroughThePseudoconsole()
    {
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var received = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var session = await ConPtySession.StartAsync(Profile("[Console]::WriteLine('INPUT_READY')", keepOpen: true), Guid.NewGuid());
        var drain = Task.Run(async () =>
        {
            var output = new StringBuilder();
            await foreach (var text in session.Output.ReadAllAsync())
            {
                output.Append(text);
                var content = output.ToString();
                if (content.Contains("INPUT_READY", StringComparison.Ordinal)) ready.TrySetResult();
                if (content.Contains("UTF8-INPUT:\u03bb\u4e2d", StringComparison.Ordinal)) received.TrySetResult();
            }
        });
        try
        {
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(20));
            await session.WriteAsync("[Console]::WriteLine(('UTF8-INPUT:' + '\u03bb\u4e2d'))\r");
            await received.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
        finally
        {
            await session.DisposeAsync();
            await drain.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }
}
