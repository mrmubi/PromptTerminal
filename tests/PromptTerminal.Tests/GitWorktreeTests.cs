using System.Diagnostics;
using PromptTerminal.Core.Git;

namespace PromptTerminal.Tests;

public sealed class GitWorktreeTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "PromptTerminal-git-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task CreatesIndependentBranchAndPreservesExistingDirtyWorktree()
    {
        var repository = await CreateRepositoryAsync();
        var destination = Path.Combine(_root, "agent space \u03bb");
        var created = await GitWorktreeService.CreateAsync(repository, destination, "agents/reviewer");
        Assert.Equal(destination, created);
        Assert.Equal("agents/reviewer", await GitWorktreeService.BranchAsync(created));
        var dirty = Path.Combine(destination, "unfinished.txt");
        await File.WriteAllTextAsync(dirty, "Do not delete this work.");
        await Assert.ThrowsAsync<IOException>(() => GitWorktreeService.CreateAsync(repository, destination, "another"));
        Assert.Equal("Do not delete this work.", await File.ReadAllTextAsync(dirty));
    }

    [Theory]
    [InlineData("invalid branch")]
    [InlineData("--not-a-branch")]
    public async Task InvalidBranchesDoNotCreateDirectories(string branch)
    {
        var repository = await CreateRepositoryAsync();
        var destination = Path.Combine(_root, "rejected");
        await Assert.ThrowsAsync<IOException>(() => GitWorktreeService.CreateAsync(repository, destination, branch));
        Assert.False(Directory.Exists(destination));
    }

    private async Task<string> CreateRepositoryAsync()
    {
        var repository = Path.Combine(_root, "repository");
        var emptyTemplate = Path.Combine(_root, "empty-template");
        Directory.CreateDirectory(repository);
        Directory.CreateDirectory(emptyTemplate);
        await RunGitAsync(repository, "init", "--initial-branch=main", "--template=" + emptyTemplate);
        await RunGitAsync(repository, "config", "core.hooksPath", emptyTemplate);
        await RunGitAsync(repository, "-c", "user.name=PromptTerminal Tests", "-c", "user.email=tests@example.invalid",
            "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m",
            "Create worktree test fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
        return repository;
    }

    private static async Task RunGitAsync(string directory, params string[] arguments)
    {
        var start = new ProcessStartInfo("git.exe")
        {
            WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add("--no-pager");
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("Unable to start Git test fixture.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        await output;
        var errors = await error;
        Assert.True(process.ExitCode == 0, errors);
    }

    public void Dispose()
    {
        if (!Directory.Exists(_root)) return;
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(_root, true);
    }
}
