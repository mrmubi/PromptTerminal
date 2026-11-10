using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Terminal;
using Xunit.Abstractions;

namespace PromptTerminal.Tests;

[CollectionDefinition("Terminal lifecycle", DisableParallelization = true)]
public sealed class TerminalLifecycleCollection;

[Collection("Terminal lifecycle")]
[SupportedOSPlatform("windows")]
public sealed class TerminalQualificationTests(ITestOutputHelper output)
{
    [Fact]
    [Trait("Category", "Qualification")]
    public async Task HundredForcedStopCyclesReleaseProcessOwnershipAndKeepNativeHandlesBounded()
    {
        async Task CycleAsync()
        {
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using var session = await ConPtySession.StartAsync(new LaunchProfile
            {
                Executable = ShellLauncher.FindDefaultShell(), LoadUserProfile = false,
                EnableIntegration = false, KeepShellOpen = true, StartupScript = "[Console]::WriteLine('CYCLE_READY')"
            }, Guid.NewGuid());
            var drain = Task.Run(async () =>
            {
                var text = new StringBuilder();
                await foreach (var batch in session.Output.ReadAllAsync())
                {
                    text.Append(batch);
                    if (text.ToString().Contains("CYCLE_READY", StringComparison.Ordinal)) ready.TrySetResult();
                }
            });
            try
            {
                await ready.Task.WaitAsync(TimeSpan.FromSeconds(20));
                Assert.True(session.ContainsProcess(session.ProcessId));
            }
            finally
            {
                await session.DisposeAsync();
                await drain.WaitAsync(TimeSpan.FromSeconds(10));
            }
            Assert.False(session.IsRunning);
            Assert.Equal(1, await session.Completion);
        }

        for (var index = 0; index < 3; index++) await CycleAsync();
        var handles = new List<int>();
        for (var cycle = 1; cycle <= 100; cycle++)
        {
            await CycleAsync();
            if (cycle % 10 != 0) continue;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            using var process = Process.GetCurrentProcess();
            handles.Add(process.HandleCount);
        }
        output.WriteLine("Native handles after each ten forced-stop cycles: " + string.Join(", ", handles));
        Assert.True(handles[^1] <= handles[0] + 4, "Native handles grew over 100 cycles: " + string.Join(", ", handles));
        var maximumGrowth = handles.Select((count, index) => count - handles.Take(index + 1).Min()).Max();
        Assert.True(maximumGrowth <= 8, "Native handle growth was not bounded: " + string.Join(", ", handles));
    }
}
