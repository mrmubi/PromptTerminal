using System.Security.Cryptography;
using System.Text.Json;
using PromptTerminal.Core.Models;

namespace PromptTerminal.Core.Persistence;

public sealed class WorkspaceStore(string path)
{
    public const int MaximumDocumentBytes = 10 * 1024 * 1024;
    private readonly SemaphoreSlim _saveLock = new(1, 1);
    private string? _savedHash;
    public string Path { get; } = System.IO.Path.GetFullPath(path);
    public string BackupPath => Path + ".bak";

    public async Task<ApplicationDocument?> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _saveLock.WaitAsync(cancellationToken);
        try
        {
            var bytes = await ReadOptionalBytesAsync(Path, cancellationToken);
            if (bytes is null)
            {
                _savedHash = null;
                return null;
            }
            var document = Deserialize<ApplicationDocument>(bytes);
            WorkspaceValidator.Validate(document);
            _savedHash = Convert.ToHexString(SHA256.HashData(bytes));
            return document;
        }
        finally { _saveLock.Release(); }
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
            await EnsureUnchangedAsync(cancellationToken);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                16_384, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(json, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            await EnsureUnchangedAsync(cancellationToken);
            if (File.Exists(Path)) File.Replace(temporary, Path, BackupPath);
            else File.Move(temporary, Path);
            _savedHash = Convert.ToHexString(SHA256.HashData(json));
        }
        finally
        {
            _saveLock.Release();
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public static async Task<T> ReadAsync<T>(string path, CancellationToken cancellationToken = default) where T : class
        => Deserialize<T>(await ReadBytesAsync(path, cancellationToken));

    public void PreserveOriginal()
    {
        if (File.Exists(Path))
            File.Move(Path, Path + ".recovered-" + DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" +
                Guid.NewGuid().ToString("N") + ".json");
        _savedHash = null;
    }

    private async Task EnsureUnchangedAsync(CancellationToken cancellationToken)
    {
        var bytes = await ReadOptionalBytesAsync(Path, cancellationToken);
        var current = bytes is null ? null : Convert.ToHexString(SHA256.HashData(bytes));
        if (current != _savedHash)
            throw new WorkspaceChangedException("The saved workspace changed outside this app, possibly on another PC. " +
                "It was not overwritten. Restart to load the latest version, or use Save now to explicitly retain it and replace it.");
    }

    private static async Task<byte[]?> ReadOptionalBytesAsync(string path, CancellationToken cancellationToken)
    {
        try { return await ReadBytesAsync(path, cancellationToken); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    private static async Task<byte[]> ReadBytesAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            16_384, FileOptions.Asynchronous);
        if (stream.Length > MaximumDocumentBytes) throw new InvalidDataException("Configuration exceeds the 10 MiB limit.");
        var bytes = new byte[(int)stream.Length];
        await stream.ReadExactlyAsync(bytes, cancellationToken);
        return bytes;
    }

    private static T Deserialize<T>(byte[] bytes) where T : class
    {
        ReadOnlySpan<byte> bom = [0xef, 0xbb, 0xbf];
        var offset = bytes.AsSpan().StartsWith(bom) ? 3 : 0;
        return JsonSerializer.Deserialize<T>(bytes.AsSpan(offset), WorkspaceJson.Options)
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

public sealed class WorkspaceChangedException(string message) : IOException(message);
