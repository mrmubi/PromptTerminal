using System.Text.Json;
using PromptTerminal.Core.Models;

namespace PromptTerminal.Tests;

public sealed class WorkspaceCommandTests
{
    private static BridgeRequest Request(string type, object data) => BridgeRequest.Parse(JsonSerializer.Serialize(new
    {
        version = 1, id = Guid.NewGuid().ToString(), type, paneId = (Guid?)null, generation = (long?)null, data
    }, WorkspaceJson.Options));

    [Fact]
    public void CommandsAreTransactionalAndDoNotModifyOriginalOnFailure()
    {
        var original = WorkspaceDefaults.Create();
        var id = original.Workspace.ActiveTabId;
        var request = Request("renameTab", new TabProperties(id, "", "#123456"));
        Assert.Throws<InvalidDataException>(() => WorkspaceCommands.Apply(original, request));
        Assert.Equal("My workspace", original.Workspace.Tabs[0].Name);
        Assert.Equal("#7C8AFF", original.Workspace.Tabs[0].AccentColor);
    }

    [Fact]
    public void SplittingFloatingDockingAndMovingPreserveExistingPaneIdentity()
    {
        var document = WorkspaceDefaults.Create();
        var firstTab = document.Workspace.Tabs[0].Id;
        var firstPane = document.Workspace.Tabs[0].Panes[0].Id;
        document = WorkspaceCommands.Apply(document, Request("splitPane", new PaneSplit(firstPane, SplitAxis.Vertical)));
        var secondPane = document.Workspace.Tabs[0].Panes[1].Id;
        Assert.NotEqual(firstPane, secondPane);
        document = WorkspaceCommands.Apply(document, Request("toggleFloat", new PaneReference(firstPane)));
        document = WorkspaceCommands.Apply(document, Request("floatingBounds", new FloatingBounds(firstPane, 90, 110, 640, 420)));
        Assert.Equal(90, document.Workspace.Tabs[0].Floating[0].X);
        document = WorkspaceCommands.Apply(document, Request("dockPane", new PaneDock(firstPane, secondPane, SplitAxis.Horizontal, true)));
        document = WorkspaceCommands.Apply(document, Request("newTab", new NewTabOptions("Second")));
        var destination = document.Workspace.ActiveTabId;
        document = WorkspaceCommands.Apply(document, Request("movePane", new PaneMove(firstPane, destination)));
        Assert.Equal(firstPane, WorkspaceCommands.FindPane(document.Workspace, firstPane).Pane.Id);
        Assert.Equal(destination, WorkspaceCommands.FindPane(document.Workspace, firstPane).Tab.Id);
        Assert.Single(WorkspaceCommands.FindTab(document.Workspace, firstTab).Panes);
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void ClosingLastTabLeavesAValidEmptyWorkspaceAndCleansDependencies()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        document = WorkspaceCommands.Apply(document, Request("closeTab", new TabReference(tab.Id)));
        Assert.Single(document.Workspace.Tabs);
        Assert.Empty(document.Workspace.Tabs[0].Panes);
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void ClosingPrerequisiteRemovesDependenciesAcrossTabs()
    {
        var document = WorkspaceDefaults.Create();
        var firstPane = document.Workspace.Tabs[0].Panes[0].Id;
        document = WorkspaceCommands.Apply(document, Request("newTab", new NewTabOptions("Dependent")));
        document.Workspace.Tabs[1].Panes[0].Plan.AfterPaneId = firstPane;
        document = WorkspaceCommands.Apply(document, Request("closePane", new PaneReference(firstPane)));
        Assert.Null(document.Workspace.Tabs[1].Panes[0].Plan.AfterPaneId);
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void TemplateAndProfileEditsDoNotModifyExistingPaneConfiguration()
    {
        var document = WorkspaceDefaults.Create();
        var profile = WorkspaceJson.Clone(document.Profiles[0]);
        profile.StartupScript = "changed";
        document = WorkspaceCommands.Apply(document, Request("saveProfile", profile));
        Assert.Empty(document.Workspace.Tabs[0].Panes[0].Profile.StartupScript);
        document = WorkspaceCommands.Apply(document, Request("applyTemplate", new ItemReference(document.Templates[0].Id)));
        Assert.Equal(4, document.Workspace.Tabs[1].Panes.Count);
        Assert.DoesNotContain(document.Workspace.Tabs[1].Panes[0].Id, document.Templates[0].Tab.Panes.Select(p => p.Id));
    }

    [Theory]
    [InlineData("Ctrl+Shift+T", "Shift+Ctrl+T")]
    [InlineData("Ctrl+T", "Ctrl+Ctrl+T")]
    public void EquivalentOrRepeatedShortcutModifiersAreRejected(string first, string second)
    {
        var settings = new AppSettings { Shortcuts = new() { ["newTab"] = first, ["newPane"] = second } };
        Assert.Throws<InvalidDataException>(() => WorkspaceValidator.Validate(settings));
    }

    [Theory]
    [InlineData("""{"version":2,"id":"x","type":"ready","paneId":null,"generation":null,"data":{}}""")]
    [InlineData("""{"version":1,"id":"x","type":"ready","paneId":null,"generation":null,"data":{},"unexpected":true}""")]
    [InlineData("""{"version":1,"id":"x","type":"ready","paneId":null,"generation":null,"data":null}""")]
    [InlineData("""{"version":1,"id":"x","type":"ready","data":{}}""")]
    public void BridgeRejectsMalformedOrUnversionedMessages(string json)
    {
        Assert.ThrowsAny<Exception>(() => BridgeRequest.Parse(json));
    }

    [Fact]
    public void TypedCommandsRejectMissingOrUnknownData()
    {
        var document = WorkspaceDefaults.Create();
        Assert.Throws<JsonException>(() => WorkspaceCommands.Apply(document, Request("renameTab", new { name = "Missing ID" })));
        Assert.Throws<JsonException>(() => WorkspaceCommands.Apply(document, Request("closePane", new { paneId = Guid.NewGuid(), command = "arbitrary" })));
        Assert.Throws<InvalidDataException>(() => WorkspaceCommands.Apply(document, Request("unknown", new { })));
    }

    [Fact]
    public void ReorderingTabsPreservesActiveSelection()
    {
        var document = WorkspaceDefaults.Create();
        document = WorkspaceCommands.Apply(document, Request("newTab", new NewTabOptions("Second")));
        var active = document.Workspace.ActiveTabId;
        document = WorkspaceCommands.Apply(document, Request("reorderTab", new TabOrder(active, 0)));
        Assert.Equal(active, document.Workspace.ActiveTabId);
        Assert.Equal(active, document.Workspace.Tabs[0].Id);
    }

    [Theory]
    [InlineData("deleteProfile")]
    [InlineData("deleteSnippet")]
    [InlineData("deleteTemplate")]
    public void DeletingMissingConfigurationIsReportedInsteadOfSilentlySucceeding(string command)
    {
        Assert.Throws<InvalidDataException>(() => WorkspaceCommands.Apply(WorkspaceDefaults.Create(),
            Request(command, new ItemReference(Guid.NewGuid()))));
    }

    [Fact]
    public void NewPaneInheritsFloatingSizeAndAppearsAlongsideExistingPanel()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        var original = tab.Panes[0].Id;
        WorkspaceLayout.ToggleFloating(tab, original);
        tab.Floating[0].X = 25;
        tab.Floating[0].Y = 60;
        tab.Floating[0].Width = 640;
        tab.Floating[0].Height = 420;
        document = WorkspaceCommands.Apply(document,
            Request("addPane", new PaneCreation(tab.Id, original, null, null, new())));
        var updated = document.Workspace.Tabs[0];
        var added = updated.Floating.Single(item => item.PaneId == updated.ActivePaneId);
        Assert.Equal(677, added.X);
        Assert.Equal(60, added.Y);
        Assert.Equal(640, added.Width);
        Assert.Equal(420, added.Height);
        Assert.Equal(2, updated.Floating.Count);
        Assert.Null(updated.Root);
    }

    [Fact]
    public void AutomaticTiledPaneInheritsSplitDirectionButExplicitSplitStaysTiled()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        WorkspaceLayout.AddPane(tab, new(), axis: SplitAxis.Vertical, floating: false);
        WorkspaceLayout.AddPane(tab, new());
        Assert.Equal(SplitAxis.Vertical, tab.Root!.Second!.Axis);
        var floatingPane = tab.ActivePaneId!.Value;
        WorkspaceLayout.ToggleFloating(tab, floatingPane);
        document = WorkspaceCommands.Apply(document,
            Request("splitPane", new PaneSplit(floatingPane, SplitAxis.Horizontal)));
        var updated = document.Workspace.Tabs[0];
        Assert.Single(updated.Floating);
        Assert.DoesNotContain(updated.Floating, item => item.PaneId == updated.ActivePaneId);
    }

    [Fact]
    public void SettingsChangesPreserveNativeWindowPreferencesAndSplitCopiesDoNotRepeatSchedules()
    {
        var document = WorkspaceDefaults.Create();
        document.MainWindow = new() { Width = 1100, Height = 720, Maximized = true };
        document.Workspace.Tabs[0].Panes[0].Plan.Recurrence = new();
        document = WorkspaceCommands.Apply(document, Request("settings", new AppSettings { PreventSleep = true }));
        Assert.Equal(1100, document.MainWindow.Width);
        Assert.Equal(720, document.MainWindow.Height);
        Assert.True(document.MainWindow.Maximized);
        document = WorkspaceCommands.Apply(document, Request("splitPane",
            new PaneSplit(document.Workspace.Tabs[0].Panes[0].Id, SplitAxis.Vertical)));
        Assert.Null(document.Workspace.Tabs[0].Panes[1].Plan.Recurrence);
    }
}
