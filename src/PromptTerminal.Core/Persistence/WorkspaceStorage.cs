using System.Security.Cryptography;
using System.Text;

namespace PromptTerminal.Core.Persistence;

public sealed record WorkspaceStorage(string DataDirectory, string LocalDirectory, string BrowserDirectory,
    bool IsOneDrive, bool UsesDefaultDirectory)
{
    public string WorkspacePath => Path.Combine(DataDirectory, "workspace.json");
    private string DirectoryKey => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(Path.TrimEndingDirectorySeparator(DataDirectory).ToUpperInvariant())));
    public string MigrationMarkerPath => Path.Combine(LocalDirectory, "Migrations", DirectoryKey + ".complete");

    public static WorkspaceStorage Resolve(string localApplicationData, IEnumerable<string?> oneDriveDirectories,
        string? directoryOverride = null)
    {
        if (!Path.IsPathFullyQualified(localApplicationData))
            throw new ArgumentException("Local application data must be an absolute directory.", nameof(localApplicationData));
        if (directoryOverride is not null && !Path.IsPathFullyQualified(directoryOverride))
            throw new ArgumentException("The data directory override must be absolute.", nameof(directoryOverride));
        var local = Path.Combine(Path.GetFullPath(localApplicationData), "PromptTerminal");
        var roots = oneDriveDirectories.OfType<string>().Where(path => !string.IsNullOrWhiteSpace(path)).ToArray();
        var selectedRoot = roots.FirstOrDefault();
        if (directoryOverride is null && selectedRoot is not null)
        {
            if (!Path.IsPathFullyQualified(selectedRoot) || !Directory.Exists(selectedRoot))
                throw new DirectoryNotFoundException("The configured OneDrive folder is unavailable. Start OneDrive or " +
                    "use --data-directory with an explicit local folder. No configuration was moved.");
        }
        var directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directoryOverride ??
            (selectedRoot is null ? local : Path.Combine(selectedRoot, "PromptTerminal"))));
        var synced = roots.Any(root => Path.IsPathFullyQualified(root) && IsWithin(directory, root));
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(directory.ToUpperInvariant())));
        var browser = synced ? Path.Combine(local, "BrowserProfiles", key) : Path.Combine(directory, "WebView2");
        return new(directory, local, browser, synced, directoryOverride is null);
    }

    public bool Initialize()
    {
        Directory.CreateDirectory(DataDirectory);
        if (!IsOneDrive || !UsesDefaultDirectory || File.Exists(MigrationMarkerPath)) return false;
        var legacy = Path.Combine(LocalDirectory, "workspace.json");
        var migrated = false;
        if (!File.Exists(WorkspacePath) && File.Exists(legacy))
        {
            if (File.Exists(legacy + ".bak") && !File.Exists(WorkspacePath + ".bak"))
                CopyConfiguration(legacy + ".bak", WorkspacePath + ".bak");
            CopyConfiguration(legacy, WorkspacePath);
            migrated = true;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(MigrationMarkerPath)!);
        File.WriteAllText(MigrationMarkerPath, "Legacy workspace migration has been considered for this OneDrive directory.");
        return migrated;
    }

    private static bool IsWithin(string path, string root)
    {
        root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        return path.Equals(root, StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith(Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
    }

    private static void CopyConfiguration(string source, string destination)
    {
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (input.Length > WorkspaceStore.MaximumDocumentBytes)
                    throw new InvalidDataException("The existing configuration exceeds the 10 MiB limit and was not migrated.");
                using var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                input.CopyTo(output);
                output.Flush(flushToDisk: true);
            }
            File.Move(temporary, destination);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
