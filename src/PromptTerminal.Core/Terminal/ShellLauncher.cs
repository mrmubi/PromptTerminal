using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using PromptTerminal.Core.Models;

namespace PromptTerminal.Core.Terminal;

public sealed record ShellLaunch(string Executable, string Arguments, string WorkingDirectory,
    IReadOnlyDictionary<string, string> Environment);

public static class ShellLauncher
{
    private static readonly ConcurrentDictionary<string, string> AliasTargets = new(StringComparer.OrdinalIgnoreCase);

    public static string FindDefaultShell()
    {
        var programFiles = System.Environment.GetFolderPath(System.Environment.SpecialFolder.ProgramFiles);
        var installed = Path.Combine(programFiles, "PowerShell", "7", "pwsh.exe");
        if (File.Exists(installed)) return installed;
        var pwsh = FindOnPath("pwsh.exe");
        if (pwsh is not null) return pwsh;
        return Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
    }

    public static string ResolveExecutable(string executable)
    {
        var expanded = System.Environment.ExpandEnvironmentVariables(executable);
        var resolved = Path.IsPathFullyQualified(expanded) ? expanded : FindOnPath(expanded);
        if (resolved is null || !File.Exists(resolved))
            throw new FileNotFoundException($"PowerShell executable was not found: {executable}");
        var name = Path.GetFileName(resolved);
        if (!name.Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase) &&
            !name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Choose pwsh.exe (PowerShell 7) or powershell.exe (Windows PowerShell).");
        if (name.Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase) &&
            resolved.Contains("\\WindowsApps\\", StringComparison.OrdinalIgnoreCase) &&
            new FileInfo(resolved).Length == 0)
            resolved = AliasTargets.GetOrAdd(resolved, ResolvePackagedAlias);
        return Path.GetFullPath(resolved);
    }

    private static string ResolvePackagedAlias(string alias)
    {
        // Store aliases launch through a broker, outside the intended job. Launch the actual binary instead.
        var start = new ProcessStartInfo(alias)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::ProcessPath" })
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("Unable to resolve the PowerShell application alias.");
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15_000))
        {
            process.Kill(entireProcessTree: true);
            throw new IOException("Resolving the PowerShell application alias exceeded 15 seconds.");
        }
        var target = output.GetAwaiter().GetResult().Trim();
        var error = errors.GetAwaiter().GetResult();
        if (process.ExitCode != 0 || !Path.IsPathFullyQualified(target) || !File.Exists(target) ||
            !Path.GetFileName(target).Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Unable to resolve the PowerShell application alias: " + error.Trim());
        return target;
    }

    public static ShellLaunch Build(LaunchProfile profile, Guid paneId, string? signalPipe = null)
    {
        WorkspaceValidator.Validate(profile);
        var executable = ResolveExecutable(profile.Executable);
        var directory = Path.GetFullPath(System.Environment.ExpandEnvironmentVariables(profile.WorkingDirectory));
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException($"Working directory does not exist: {directory}");
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry pair in System.Environment.GetEnvironmentVariables())
            if (pair.Key is string key && pair.Value is string value &&
                !key.StartsWith("PROMPTTERMINAL_", StringComparison.OrdinalIgnoreCase)) environment[key] = value;
        foreach (var pair in profile.Environment) environment[pair.Key] = pair.Value;
        environment["TERM"] = "xterm-256color";
        environment["COLORTERM"] = "truecolor";
        environment["PROMPTTERMINAL_PANE_ID"] = paneId.ToString();
        if (profile.EnableIntegration && signalPipe is not null) environment["PROMPTTERMINAL_SIGNAL_PIPE"] = signalPipe;

        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(profile.StartupScript));
        var chunks = (payload.Length + 7999) / 8000;
        for (var index = 0; index < chunks; index++)
            environment[$"PROMPTTERMINAL_STARTUP_{index}"] = payload.Substring(index * 8000, Math.Min(8000, payload.Length - index * 8000));

        // Chunked environment transport keeps arbitrary scripts out of the Windows command line.
        var initialization = """
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            $global:OutputEncoding = [Text.UTF8Encoding]::new($false)

            """ + (profile.EnableIntegration && signalPipe is not null ? SignalFunction : "") + $$"""

            $__pt = ''
            for ($__pti = 0; $__pti -lt {{chunks}}; $__pti++) {
                $__ptkey = 'PROMPTTERMINAL_STARTUP_' + $__pti
                $__pt += [Environment]::GetEnvironmentVariable($__ptkey, 'Process')
                [Environment]::SetEnvironmentVariable($__ptkey, $null, 'Process')
            }
            $global:LASTEXITCODE = 0
            try {
                . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__pt))))
                $__ptok = $?
                $__ptexit = $global:LASTEXITCODE
            } catch {
                Write-Error -ErrorRecord $_
                $__ptok = $false
                $__ptexit = 1
            } finally {
                $__pt = $null
            }
            """ + (profile.KeepShellOpen ? "" : """

            if (-not $__ptok -and $__ptexit -eq 0) { exit 1 }
            exit $__ptexit
            """);
        var arguments = "-NoLogo " + (profile.LoadUserProfile ? "" : "-NoProfile ") +
                        (profile.KeepShellOpen ? "-NoExit " : "") +
                        "-EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(initialization));
        return new ShellLaunch(executable, arguments, directory, environment);
    }

    private static string? FindOnPath(string executable)
    {
        if (executable.IndexOfAny([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar]) >= 0)
            return File.Exists(executable) ? Path.GetFullPath(executable) : null;
        foreach (var entry in (System.Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(entry)) continue;
            var candidate = Path.Combine(entry.Trim('"'), executable);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private const string SignalFunction = """
        function global:Send-PromptTerminalSignal {
            param(
                [Parameter(Mandatory=$true)]
                [ValidateSet('working','waiting','completed','directory')]
                [string]$State,
                [string]$Message = ''
            )
            $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $env:PROMPTTERMINAL_SIGNAL_PIPE, [IO.Pipes.PipeDirection]::Out)
            try {
                $pipe.Connect(1500)
                $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false))
                try {
                    if ($State -eq 'directory') { $Message = $PWD.Path }
                    $writer.WriteLine((@{state=$State; message=$Message} | ConvertTo-Json -Compress))
                    $writer.Flush()
                } finally { $writer.Dispose() }
            } finally { $pipe.Dispose() }
        }
        """;
}
