using System.Diagnostics;

namespace PromptTerminal.Core.Git;

public static class GitWorktreeService
{
    public static async Task<string> CreateAsync(string repository, string destination, string branch,
        CancellationToken cancellationToken = default)
    {
        repository = Path.GetFullPath(repository);
        destination = Path.GetFullPath(destination);
        if (!Directory.Exists(repository)) throw new DirectoryNotFoundException("The repository directory does not exist.");
        if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("The worktree destination already exists.");
        if (string.IsNullOrWhiteSpace(branch)) throw new InvalidDataException("A new branch name is required.");
        await RunAsync(repository, ["check-ref-format", "--branch", branch], cancellationToken);
        var root = (await RunAsync(repository, ["rev-parse", "--show-toplevel"], cancellationToken)).Trim();
        await RunAsync(root, ["worktree", "add", "-b", branch, destination], cancellationToken);
        return destination;
    }

    public static async Task<string> BranchAsync(string directory, CancellationToken cancellationToken = default) =>
        (await RunAsync(directory, ["branch", "--show-current"], cancellationToken)).Trim();

    private static async Task<string> RunAsync(string directory, string[] arguments, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo("git.exe")
        {
            WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add("--no-pager");
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("Git did not start.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(60));
        var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var errors = process.StandardError.ReadToEndAsync(timeout.Token);
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new IOException("Git operation was cancelled or exceeded 60 seconds.");
        }
        var text = await output;
        var error = await errors;
        if (process.ExitCode != 0) throw new IOException($"Git exited with code {process.ExitCode}: {error.Trim()}");
        return text;
    }
}
