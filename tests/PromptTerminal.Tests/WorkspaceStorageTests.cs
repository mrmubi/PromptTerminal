using System.Text;
using System.Text.Json;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Persistence;

namespace PromptTerminal.Tests;

public sealed class WorkspaceStorageTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "PromptTerminal-storage-" + Guid.NewGuid().ToString("N"));
    private string Local => Path.Combine(_directory, "LocalAppData");
    private string Legacy => Path.Combine(Local, "PromptTerminal", "workspace.json");

    private string OneDrive(string name = "OneDrive")
    {
        var path = Path.Combine(_directory, name);
        Directory.CreateDirectory(path);
        return path;
    }

    private async Task CreateLegacyAsync()
    {
        var document = WorkspaceDefaults.Create();
        await new WorkspaceStore(Legacy).SaveAsync(document);
        document.Workspace.Tabs[0].Name = "Latest local workspace";
        var store = new WorkspaceStore(Legacy);
        await store.LoadAsync();
        await store.SaveAsync(document);
    }

    [Fact]
    public void DefaultUsesTheFirstConfiguredOneDriveAndKeepsItsCacheOutsideTheSyncRoot()
    {
        var primary = OneDrive();
        var secondary = OneDrive("Other OneDrive");
        var storage = WorkspaceStorage.Resolve(Local, [null, "", primary, secondary]);
        Assert.Equal(Path.Combine(primary, "PromptTerminal"), storage.DataDirectory);
        Assert.True(storage.IsOneDrive);
        Assert.True(storage.UsesDefaultDirectory);
        Assert.StartsWith(Path.Combine(Local, "PromptTerminal", "BrowserProfiles") + Path.DirectorySeparatorChar, storage.BrowserDirectory);
        Assert.DoesNotContain(primary, storage.BrowserDirectory);
        Assert.StartsWith(Path.Combine(Local, "PromptTerminal", "Migrations") + Path.DirectorySeparatorChar, storage.MigrationMarkerPath);
    }

    [Fact]
    public void NoOneDrivePreservesTheLocalDefaultAndCacheLocation()
    {
        var storage = WorkspaceStorage.Resolve(Local, [null, ""]);
        Assert.Equal(Path.GetDirectoryName(Legacy), storage.DataDirectory);
        Assert.Equal(Path.Combine(storage.DataDirectory, "WebView2"), storage.BrowserDirectory);
        Assert.False(storage.IsOneDrive);
        Assert.False(storage.Initialize());
        Assert.False(File.Exists(storage.MigrationMarkerPath));
    }

    [Fact]
    public void AnUnavailableConfiguredOneDriveFailsInsteadOfSilentlyCreatingASecondWorkspace()
    {
        var unavailable = Path.Combine(_directory, "Missing OneDrive");
        Assert.Throws<DirectoryNotFoundException>(() => WorkspaceStorage.Resolve(Local, [unavailable, OneDrive()]));
        Assert.False(Directory.Exists(unavailable));
    }

    [Theory]
    [InlineData("relative-local", null)]
    [InlineData(@"C:\LocalAppData", "relative-override")]
    public void StorageRequiresAbsolutePaths(string local, string? overridden) =>
        Assert.Throws<ArgumentException>(() => WorkspaceStorage.Resolve(local, [], overridden));

    [Fact]
    public async Task AnExplicitLocalDirectoryStaysIsolatedAndDoesNotMigrateTheDefaultWorkspace()
    {
        await CreateLegacyAsync();
        var overridden = Path.Combine(_directory, "Explicit");
        var storage = WorkspaceStorage.Resolve(Local, [OneDrive()], overridden);
        Assert.False(storage.IsOneDrive);
        Assert.False(storage.UsesDefaultDirectory);
        Assert.Equal(overridden, storage.DataDirectory);
        Assert.Equal(Path.Combine(overridden, "WebView2"), storage.BrowserDirectory);
        Assert.False(storage.Initialize());
        Assert.False(File.Exists(storage.WorkspacePath));
        Assert.True(File.Exists(Legacy));
    }

    [Fact]
    public void ExplicitOneDriveDirectoriesStillUseLocalCachesAndDoNotMatchSimilarSiblingNames()
    {
        var root = OneDrive();
        var first = WorkspaceStorage.Resolve(Local, [root], Path.Combine(root, "First"));
        var second = WorkspaceStorage.Resolve(Local, [root], Path.Combine(root, "Second"));
        var sibling = WorkspaceStorage.Resolve(Local, [root], root + "-not-synced");
        Assert.True(first.IsOneDrive);
        Assert.NotEqual(first.BrowserDirectory, second.BrowserDirectory);
        Assert.False(first.Initialize());
        Assert.False(File.Exists(first.MigrationMarkerPath));
        Assert.False(sibling.IsOneDrive);
    }

    [Fact]
    public async Task MigrationCopiesOnlyConfigurationAndBackupWithoutChangingLocalOriginals()
    {
        await CreateLegacyAsync();
        var original = await File.ReadAllBytesAsync(Legacy);
        var backup = await File.ReadAllBytesAsync(Legacy + ".bak");
        var oldCache = Path.Combine(Path.GetDirectoryName(Legacy)!, "WebView2");
        Directory.CreateDirectory(oldCache);
        await File.WriteAllTextAsync(Path.Combine(oldCache, "cache-only.txt"), "Must remain local");
        var storage = WorkspaceStorage.Resolve(Local, [OneDrive()]);
        Assert.True(storage.Initialize());
        Assert.Equal(original, await File.ReadAllBytesAsync(storage.WorkspacePath));
        Assert.Equal(backup, await File.ReadAllBytesAsync(storage.WorkspacePath + ".bak"));
        Assert.Equal(original, await File.ReadAllBytesAsync(Legacy));
        Assert.Equal(backup, await File.ReadAllBytesAsync(Legacy + ".bak"));
        Assert.Equal(2, Directory.GetFiles(storage.DataDirectory, "*", SearchOption.AllDirectories).Length);
        Assert.True(File.Exists(storage.MigrationMarkerPath));
        Assert.False(storage.Initialize());
        File.Delete(storage.WorkspacePath);
        Assert.False(storage.Initialize());
        Assert.False(File.Exists(storage.WorkspacePath));
    }

    [Fact]
    public async Task ExistingSyncedConfigurationWinsAndIsNeverReplacedByALocalCopy()
    {
        await CreateLegacyAsync();
        var storage = WorkspaceStorage.Resolve(Local, [OneDrive()]);
        Directory.CreateDirectory(storage.DataDirectory);
        await File.WriteAllTextAsync(storage.WorkspacePath, "Existing cloud configuration, even if invalid");
        Assert.False(storage.Initialize());
        Assert.Equal("Existing cloud configuration, even if invalid", await File.ReadAllTextAsync(storage.WorkspacePath));
        Assert.False(File.Exists(storage.WorkspacePath + ".bak"));
    }

    [Fact]
    public async Task MigrationDoesNotOverwriteAnExistingCloudBackup()
    {
        await CreateLegacyAsync();
        var storage = WorkspaceStorage.Resolve(Local, [OneDrive()]);
        Directory.CreateDirectory(storage.DataDirectory);
        await File.WriteAllTextAsync(storage.WorkspacePath + ".bak", "Existing cloud backup");
        Assert.True(storage.Initialize());
        Assert.Equal("Existing cloud backup", await File.ReadAllTextAsync(storage.WorkspacePath + ".bak"));
    }

    [Fact]
    public void OversizedLegacyConfigurationIsRetainedWithoutPartialSyncedFiles()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Legacy)!);
        using (var stream = File.Create(Legacy)) stream.SetLength(WorkspaceStore.MaximumDocumentBytes + 1);
        var storage = WorkspaceStorage.Resolve(Local, [OneDrive()]);
        Assert.Throws<InvalidDataException>(() => storage.Initialize());
        Assert.False(File.Exists(storage.WorkspacePath));
        Assert.False(File.Exists(storage.MigrationMarkerPath));
        Assert.Empty(Directory.GetFiles(storage.DataDirectory));
        Assert.True(File.Exists(Legacy));
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}

public sealed class WorkspaceStoreConflictTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "PromptTerminal-conflict-" + Guid.NewGuid().ToString("N"));
    private string PathName => Path.Combine(_directory, "workspace.json");

    [Fact]
    public async Task ExternalUpdatesAreNotOverwrittenAndTheBackupIsNotChanged()
    {
        var first = new WorkspaceStore(PathName);
        await first.SaveAsync(WorkspaceDefaults.Create());
        var second = new WorkspaceStore(PathName);
        var stale = (await second.LoadAsync())!;
        var latest = (await first.LoadAsync())!;
        latest.Workspace.Tabs[0].Name = "Other PC";
        await first.SaveAsync(latest);
        var current = await File.ReadAllBytesAsync(PathName);
        var backup = await File.ReadAllBytesAsync(first.BackupPath);
        stale.Workspace.Tabs[0].Name = "Stale edit";
        await Assert.ThrowsAsync<WorkspaceChangedException>(() => second.SaveAsync(stale));
        Assert.Equal(current, await File.ReadAllBytesAsync(PathName));
        Assert.Equal(backup, await File.ReadAllBytesAsync(first.BackupPath));
        Assert.Empty(Directory.GetFiles(_directory, "*.tmp"));
    }

    [Fact]
    public async Task AFileSyncedAfterAnEmptyLoadIsNotOverwritten()
    {
        var stale = new WorkspaceStore(PathName);
        Assert.Null(await stale.LoadAsync());
        await new WorkspaceStore(PathName).SaveAsync(WorkspaceDefaults.Create());
        await Assert.ThrowsAsync<WorkspaceChangedException>(() => stale.SaveAsync(WorkspaceDefaults.Create()));
    }

    [Fact]
    public async Task ExternalDeletionIsNotSilentlyUndone()
    {
        var store = new WorkspaceStore(PathName);
        await store.SaveAsync(WorkspaceDefaults.Create());
        File.Delete(PathName);
        await Assert.ThrowsAsync<WorkspaceChangedException>(() => store.SaveAsync(WorkspaceDefaults.Create()));
        Assert.False(File.Exists(PathName));
    }

    [Fact]
    public async Task AnUnloadedStoreCannotReplaceAnExistingWorkspace()
    {
        await new WorkspaceStore(PathName).SaveAsync(WorkspaceDefaults.Create());
        await Assert.ThrowsAsync<WorkspaceChangedException>(() => new WorkspaceStore(PathName).SaveAsync(WorkspaceDefaults.Create()));
    }

    [Fact]
    public async Task ExplicitReplacementRetainsTheExternallyChangedVersion()
    {
        var store = new WorkspaceStore(PathName);
        var chosen = WorkspaceDefaults.Create();
        await store.SaveAsync(chosen);
        var external = new WorkspaceStore(PathName);
        var changed = (await external.LoadAsync())!;
        changed.Workspace.Tabs[0].Name = "Other PC";
        await external.SaveAsync(changed);
        var original = await File.ReadAllBytesAsync(PathName);
        store.PreserveOriginal();
        await store.SaveAsync(chosen);
        var retained = Assert.Single(Directory.GetFiles(_directory, "*.recovered-*.json"));
        Assert.Equal(original, await File.ReadAllBytesAsync(retained));
        Assert.Equal(chosen.Workspace.Tabs[0].Name, (await store.LoadAsync())!.Workspace.Tabs[0].Name);
    }

    [Fact]
    public async Task MetadataChangesWithoutContentChangesDoNotCauseAConflict()
    {
        var store = new WorkspaceStore(PathName);
        var document = WorkspaceDefaults.Create();
        await store.SaveAsync(document);
        File.SetLastWriteTimeUtc(PathName, DateTime.UtcNow.AddMinutes(1));
        document.Settings.Theme = ThemePreference.Light;
        await store.SaveAsync(document);
        Assert.Equal(ThemePreference.Light, (await store.LoadAsync())!.Settings.Theme);
    }

    [Fact]
    public async Task Utf8BomDocumentsRemainReadableAndCanBeSaved()
    {
        Directory.CreateDirectory(_directory);
        var document = WorkspaceDefaults.Create();
        await File.WriteAllTextAsync(PathName, JsonSerializer.Serialize(document, WorkspaceJson.Options), new UTF8Encoding(true));
        var store = new WorkspaceStore(PathName);
        var restored = (await store.LoadAsync())!;
        await store.SaveAsync(restored);
        Assert.Equal(document.Workspace.Tabs[0].Id, (await WorkspaceStore.ReadAsync<ApplicationDocument>(PathName)).Workspace.Tabs[0].Id);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}
