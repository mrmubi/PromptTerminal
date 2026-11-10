using System.Text.Json;
using PromptTerminal.Core.Models;

namespace PromptTerminal.Core.Persistence;

public sealed class WorkspaceStore(string path)
{
    public const int MaximumDocumentBytes = 10 * 1024 * 1024;
    private readonly SemaphoreSlim _saveLock = new(1, 1);
    public string Path { get; } = System.IO.Path.GetFullPath(path);
    public string BackupPath => Path + ".bak";

    public async Task<ApplicationDocument?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(Path)) return null;
        var document = await ReadAsync<ApplicationDocument>(Path, cancellationToken);
        WorkspaceValidator.Validate(document);
        return document;
    }

    public async Task SaveAsync(ApplicationDocument document, CancellationToken cancellationToken = default)
    {
        WorkspaceValidator.Validate(document);
        var json = JsonSerializer.SerializeToUtf8Bytes(document, WorkspaceJson.Options);
        if (json.Length > MaximumDocumentBytes) throw new InvalidDataException("Workspace exceeds the 10 MiB configuration limit.");
        await _saveLock.WaitAsync(cancellationToken);
        var temporary = Path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                16_384, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(json, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            if (File.Exists(Path)) File.Replace(temporary, Path, BackupPath);
            else File.Move(temporary, Path);
        }
        finally
        {
            _saveLock.Release();
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public static async Task<T> ReadAsync<T>(string path, CancellationToken cancellationToken = default) where T : class
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            16_384, FileOptions.Asynchronous);
        if (stream.Length > MaximumDocumentBytes) throw new InvalidDataException("Configuration exceeds the 10 MiB limit.");
        return await JsonSerializer.DeserializeAsync<T>(stream, WorkspaceJson.Options, cancellationToken)
            ?? throw new InvalidDataException("Configuration is empty.");
    }

    public static WorkspaceDocument Export(WorkspaceDocument workspace, bool includeScripts)
    {
        var clone = WorkspaceJson.Clone(workspace);
        if (!includeScripts)
        {
            foreach (var pane in clone.Tabs.SelectMany(t => t.Panes))
            {
                pane.Profile.StartupScript = "";
                pane.Profile.ResumeScript = "";
                pane.Profile.Environment.Clear();
            }
        }
        return clone;
    }
}
