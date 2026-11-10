using System.Text.Json;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Persistence;

namespace PromptTerminal.Tests;

public sealed class WorkspaceTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "PromptTerminal-tests-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void HybridLayoutMaintainsExactlyOnePlacementDuringMoves()
    {
        var workspace = WorkspaceDefaults.Create().Workspace;
        var first = workspace.Tabs[0];
        var id = first.Panes[0].Id;
        var secondPane = new PaneDefinition();
        WorkspaceLayout.AddPane(first, secondPane, id, SplitAxis.Vertical);
        WorkspaceLayout.ToggleFloating(first, id);
        Assert.Single(first.Floating);
        WorkspaceValidator.Validate(workspace);
        WorkspaceLayout.Dock(first, id, secondPane.Id, SplitAxis.Horizontal, true);
        Assert.Empty(first.Floating);
        var other = WorkspaceLayout.AddTab(workspace, "Other");
        WorkspaceLayout.MovePane(first, other, id);
        WorkspaceValidator.Validate(workspace);
        Assert.Equal(id, other.Panes[0].Id);
        Assert.Single(first.Panes);
    }

    [Fact]
    public void DuplicateCreatesNewPaneAndLayoutIdsAndRemapsDependencies()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Templates[0].Tab;
        tab.Panes[1].Plan.AfterPaneId = tab.Panes[0].Id;
        WorkspaceLayout.ToggleFloating(tab, tab.Panes[3].Id);
        var copy = WorkspaceLayout.Duplicate(tab);
        document.Workspace.Tabs.Add(copy);
        WorkspaceValidator.Validate(document);
        Assert.DoesNotContain(copy.Panes[0].Id, tab.Panes.Select(p => p.Id));
        Assert.Equal(copy.Panes[0].Id, copy.Panes[1].Plan.AfterPaneId);
        Assert.Equal(copy.Panes[3].Id, copy.Floating[0].PaneId);
    }

    [Fact]
    public void ValidationRejectsDuplicatePlacementAndDependencyCycles()
    {
        var workspace = WorkspaceDefaults.Create().Workspace;
        var tab = workspace.Tabs[0];
        var pane = tab.Panes[0];
        tab.Floating.Add(new FloatingPane { PaneId = pane.Id });
        Assert.Throws<InvalidDataException>(() => WorkspaceValidator.Validate(workspace));
        tab.Floating.Clear();
        pane.Plan.AfterPaneId = pane.Id;
        Assert.Throws<InvalidDataException>(() => WorkspaceValidator.Validate(workspace));
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(-1)]
    public void InvalidFloatingGeometryIsRejected(double x)
    {
        var workspace = WorkspaceDefaults.Create().Workspace;
        var tab = workspace.Tabs[0];
        WorkspaceLayout.ToggleFloating(tab, tab.Panes[0].Id);
        tab.Floating[0].X = x;
        Assert.Throws<InvalidDataException>(() => WorkspaceValidator.Validate(workspace));
    }

    [Theory]
    [InlineData(ThemePreference.Dark)]
    [InlineData(ThemePreference.Light)]
    [InlineData(ThemePreference.System)]
    public async Task ThemeAndWorkspaceRoundTripWithoutRuntimeState(ThemePreference theme)
    {
        var document = WorkspaceDefaults.Create();
        document.Settings.Theme = theme;
        document.Settings.ScreenReaderMode = true;
        var store = new WorkspaceStore(Path.Combine(_directory, "state.json"));
        await store.SaveAsync(document);
        var restored = await store.LoadAsync();
        Assert.NotNull(restored);
        Assert.Equal(theme, restored.Settings.Theme);
        Assert.True(restored.Settings.ScreenReaderMode);
        Assert.Equal(document.Workspace.Tabs[0].Panes[0].Id, restored.Workspace.Tabs[0].Panes[0].Id);
        var json = await File.ReadAllTextAsync(store.Path);
        Assert.DoesNotContain("processId", json);
        Assert.DoesNotContain("generation", json);
    }

    [Fact]
    public async Task AtomicSaveRetainsLastValidBackupAndDoesNotReplaceOnValidationFailure()
    {
        var store = new WorkspaceStore(Path.Combine(_directory, "state.json"));
        var document = WorkspaceDefaults.Create();
        await store.SaveAsync(document);
        document.Settings.Theme = ThemePreference.Light;
        await store.SaveAsync(document);
        var backup = await WorkspaceStore.ReadAsync<ApplicationDocument>(store.BackupPath);
        Assert.Equal(ThemePreference.System, backup.Settings.Theme);
        document.Workspace.SchemaVersion = 2;
        await Assert.ThrowsAsync<InvalidDataException>(() => store.SaveAsync(document));
        Assert.Equal(ThemePreference.Light, (await store.LoadAsync())!.Settings.Theme);
        Assert.Empty(Directory.GetFiles(_directory, "*.tmp"));
    }

    [Fact]
    public async Task CorruptConfigurationIsNotSilentlyReplaced()
    {
        Directory.CreateDirectory(_directory);
        var path = Path.Combine(_directory, "state.json");
        await File.WriteAllTextAsync(path, "{\"schemaVersion\":999}");
        await Assert.ThrowsAsync<JsonException>(() => new WorkspaceStore(path).LoadAsync());
        Assert.Equal("{\"schemaVersion\":999}", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public void ExportCanOmitExecutableScriptsAndEnvironmentValues()
    {
        var workspace = WorkspaceDefaults.Create().Workspace;
        var profile = workspace.Tabs[0].Panes[0].Profile;
        profile.StartupScript = "sensitive startup";
        profile.ResumeScript = "sensitive resume";
        profile.Environment["TOKEN"] = "sensitive";
        var exported = WorkspaceStore.Export(workspace, false);
        Assert.Empty(exported.Tabs[0].Panes[0].Profile.StartupScript);
        Assert.Empty(exported.Tabs[0].Panes[0].Profile.ResumeScript);
        Assert.Empty(exported.Tabs[0].Panes[0].Profile.Environment);
        Assert.Equal("sensitive startup", profile.StartupScript);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}
