using System.Runtime.Versioning;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Terminal;

namespace PromptTerminal.Tests;

[SupportedOSPlatform("windows")]
public sealed class ShellLauncherTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "PromptTerminal-shell-" + Guid.NewGuid().ToString("N"));

    private string CreateShell(string location, string name = "pwsh.exe")
    {
        var directory = Path.Combine(_directory, location);
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, name);
        File.WriteAllText(executable, "test executable");
        return executable;
    }

    [Fact]
    public void ExistingExplicitPathWinsOverOtherInstallations()
    {
        var selected = CreateShell("selected");
        var alternative = CreateShell("alternative");
        Assert.Equal(selected, ShellLauncher.ResolveExecutable(selected, [alternative]));
    }

    [Theory]
    [InlineData(@"old-pc\Microsoft\WindowsApps\pwsh.exe")]
    [InlineData(@"old-pc\PowerShell\7\pwsh.exe")]
    [InlineData("pwsh.exe")]
    public void MissingSavedPathsAndPortableNamesResolveLocally(string saved)
    {
        var alternative = CreateShell("this-pc");
        var configured = saved.Contains('\\') ? Path.Combine(_directory, saved) : saved;
        Assert.Equal(alternative, ShellLauncher.ResolveExecutable(configured, [alternative]));
    }

    [Fact]
    public void MissingCandidatesDoNotPreventFindingAnotherInstallation()
    {
        var alternative = CreateShell("installed");
        Assert.Equal(alternative, ShellLauncher.ResolveExecutable("pwsh.exe",
            [Path.Combine(_directory, "missing", "pwsh.exe"), alternative]));
    }

    [Fact]
    public void BrokenStoreAliasDoesNotBlockAnotherPowerShell7Installation()
    {
        var alias = CreateShell("WindowsApps");
        File.WriteAllText(alias, "");
        var alternative = CreateShell("installed");
        Assert.Equal(alternative, ShellLauncher.ResolveExecutable(alias, [alternative]));
    }

    [Fact]
    public void MissingPowerShell7DoesNotFallBackToWindowsPowerShell()
    {
        var windowsPowerShell = CreateShell("windows", "powershell.exe");
        var missing = Path.Combine(_directory, "old-pc", "pwsh.exe");
        var error = Assert.Throws<FileNotFoundException>(() =>
            ShellLauncher.ResolveExecutable(missing, [windowsPowerShell]));
        Assert.Contains("Install PowerShell 7", error.Message);
        Assert.Contains("explicitly select powershell.exe", error.Message);
        Assert.Contains(missing, error.Message);
    }

    [Fact]
    public void MissingWindowsPowerShellDoesNotFallBackToPowerShell7()
    {
        var pwsh = CreateShell("installed");
        var missing = Path.Combine(_directory, "old-pc", "powershell.exe");
        Assert.Throws<FileNotFoundException>(() => ShellLauncher.ResolveExecutable(missing, [pwsh]));
    }

    [Fact]
    public void MissingWindowsPowerShellCanResolveAnotherWindowsPowerShellPath()
    {
        var alternative = CreateShell("windows", "powershell.exe");
        var missing = Path.Combine(_directory, "old-pc", "powershell.exe");
        Assert.Equal(alternative, ShellLauncher.ResolveExecutable(missing, [alternative]));
    }

    [Fact]
    public void ResolutionFailureIncludesAliasDiagnosticsAndSearchedPaths()
    {
        var alias = CreateShell("WindowsApps");
        File.WriteAllText(alias, "");
        var missing = Path.Combine(_directory, "missing", "pwsh.exe");
        var error = Assert.Throws<FileNotFoundException>(() =>
            ShellLauncher.ResolveExecutable(alias, [missing]));
        Assert.Contains("Resolution errors:", error.Message);
        Assert.Contains(alias, error.Message);
        Assert.Contains(missing, error.Message);
    }

    [Fact]
    public void UnsupportedExecutableIsRejectedInsteadOfSubstituted()
    {
        var alternative = CreateShell("installed");
        Assert.Throws<InvalidDataException>(() =>
            ShellLauncher.ResolveExecutable("cmd.exe", [alternative]));
    }

    [Fact]
    public void PublicResolverFindsWindowsPowerShellForPathFromAnotherPc()
    {
        var windowsPowerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        var missing = Path.Combine(_directory, "old-pc", "powershell.exe");
        Assert.Equal(windowsPowerShell, ShellLauncher.ResolveExecutable(missing));
    }

    [Fact]
    public void NewDefaultsUsePortableShellNames()
    {
        Assert.Contains(ShellLauncher.FindDefaultShell(), new[] { "pwsh.exe", "powershell.exe" });
    }

    [Fact]
    public void BuildDoesNotRewriteSyncedProfile()
    {
        var configured = Path.Combine(_directory, "old-pc", "powershell.exe");
        var profile = new LaunchProfile { Executable = configured };
        var launch = ShellLauncher.Build(profile, Guid.NewGuid());
        Assert.Equal(configured, profile.Executable);
        Assert.True(File.Exists(launch.Executable));
        Assert.NotEqual(configured, launch.Executable);
    }

    [Fact]
    public void PreparedLaunchCannotSwitchExecutablesAfterReview()
    {
        var profile = new LaunchProfile
        {
            Executable = Path.Combine(_directory, "removed-after-review", "powershell.exe")
        };
        Assert.Throws<FileNotFoundException>(() =>
            ShellLauncher.Build(profile, Guid.NewGuid(), allowShellDiscovery: false));
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }
}
