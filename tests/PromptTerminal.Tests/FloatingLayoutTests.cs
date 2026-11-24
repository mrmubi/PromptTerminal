using System.Text.Json;
using PromptTerminal.Core.Models;
using PromptTerminal.Core.Persistence;

namespace PromptTerminal.Tests;

public sealed class FloatingLayoutTests
{
    private static BridgeRequest Request(string type, object data) => BridgeRequest.Parse(JsonSerializer.Serialize(new
    {
        version = 1, id = Guid.NewGuid().ToString(), type, paneId = (Guid?)null, generation = (long?)null, data
    }, WorkspaceJson.Options));

    private static ApplicationDocument FloatingWorkspace(int count)
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        WorkspaceLayout.ToggleFloating(tab, tab.Panes[0].Id);
        for (var index = 1; index < count; index++) WorkspaceLayout.AddPane(tab, new());
        return document;
    }

    [Fact]
    public void NewPaneDefaultsToFloatingWithoutExistingFloatingPanelsAndAllowsAnExplicitTiledOverride()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        var created = WorkspaceCommands.Apply(document,
            Request("addPane", new PaneCreation(tab.Id, tab.ActivePaneId, null, null, new())));
        Assert.Single(created.Workspace.Tabs[0].Floating);
        Assert.True(created.Workspace.Tabs[0].AutoArrangeFloating);
        var tiled = WorkspaceCommands.Apply(document,
            Request("addPane", new PaneCreation(tab.Id, tab.ActivePaneId, null, false, new())));
        Assert.Empty(tiled.Workspace.Tabs[0].Floating);
        Assert.False(tiled.Workspace.Tabs[0].AutoArrangeFloating);
    }

    [Fact]
    public void FirstPaneOfANewTabAlsoFloatsByDefault()
    {
        var document = WorkspaceCommands.Apply(WorkspaceDefaults.Create(), Request("newTab", new NewTabOptions("New")));
        var tab = document.Workspace.Tabs.Single(tab => tab.Id == document.Workspace.ActiveTabId);
        Assert.Single(tab.Panes);
        Assert.Single(tab.Floating);
        Assert.Null(tab.Root);
    }

    [Fact]
    public void NewFloatAppendsAfterLastCreatedPaneNotTheFocusedOrHighestZPane()
    {
        var document = FloatingWorkspace(3);
        var tab = document.Workspace.Tabs[0];
        var order = tab.Floating.Select(item => item.PaneId).ToArray();
        tab.Floating[2].X = 900;
        tab.Floating[2].Y = 80;
        tab.Floating[2].Width = 480;
        tab.Floating[2].Height = 300;
        document = WorkspaceCommands.Apply(document, Request("focusPane", new PaneReference(order[0])));
        document = WorkspaceCommands.Apply(document,
            Request("addPane", new PaneCreation(tab.Id, order[0], null, true, new())));
        var placements = document.Workspace.Tabs[0].Floating;
        Assert.Equal(order, placements.Take(3).Select(item => item.PaneId));
        Assert.Equal(1392, placements[3].X);
        Assert.Equal(80, placements[3].Y);
        Assert.Equal(480, placements[3].Width);
        Assert.Equal(300, placements[3].Height);
    }

    [Fact]
    public void GridIncludesTiledPanesInCreationOrderAndPreservesPaneAndProfileIdentities()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        WorkspaceLayout.AddPane(tab, new(), floating: false);
        WorkspaceLayout.AddPane(tab, new(), floating: true);
        var panes = tab.Panes.ToArray();
        var profiles = panes.Select(item => item.Profile.Id).ToArray();
        Assert.True(FloatingLayout.Arrange(tab, 1900, 900));
        Assert.Null(tab.Root);
        Assert.Equal(panes.Select(item => item.Id), tab.Floating.Select(item => item.PaneId));
        Assert.Equal(profiles, tab.Panes.Select(item => item.Profile.Id));
        Assert.All(tab.Panes, pane => Assert.Same(panes.Single(item => item.Id == pane.Id), pane));
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void GridReflowsEqualCellsAcrossRowsAndColumnsAndDoesNotChangeFocusOrZOrder()
    {
        var document = FloatingWorkspace(6);
        var tab = document.Workspace.Tabs[0];
        var active = tab.ActivePaneId;
        var z = tab.Floating.Select(item => item.Z).ToArray();
        FloatingLayout.Arrange(tab, 1900, 900);
        Assert.Equal(3, tab.Floating.Select(item => item.X).Distinct().Count());
        Assert.Equal(2, tab.Floating.Select(item => item.Y).Distinct().Count());
        Assert.Single(tab.Floating.Select(item => item.Width).Distinct());
        Assert.Single(tab.Floating.Select(item => item.Height).Distinct());
        Assert.All(tab.Floating, item => Assert.InRange(item.X + item.Width, 0, 1890));
        Assert.All(tab.Floating, item => Assert.InRange(item.Y + item.Height, 0, 890));
        FloatingLayout.Arrange(tab, 1000, 900);
        Assert.Equal(2, tab.Floating.Select(item => item.X).Distinct().Count());
        Assert.Equal(3, tab.Floating.Select(item => item.Y).Distinct().Count());
        Assert.False(FloatingLayout.Arrange(tab, 1000, 900));
        Assert.Equal(active, tab.ActivePaneId);
        Assert.Equal(z, tab.Floating.Select(item => item.Z));
        WorkspaceValidator.Validate(document);
    }

    [Theory]
    [InlineData(1, 200)]
    [InlineData(50, 50)]
    [InlineData(700, 500)]
    [InlineData(1000, 200)]
    public void CrowdedViewportsKeepUsableMinimumsAndNeverOverlap(double width, double height)
    {
        var document = FloatingWorkspace(15);
        var tab = document.Workspace.Tabs[0];
        FloatingLayout.Arrange(tab, width, height);
        foreach (var first in tab.Floating)
        {
            Assert.True(first.Width >= FloatingLayout.MinimumWidth);
            Assert.True(first.Height >= FloatingLayout.MinimumHeight);
            foreach (var second in tab.Floating.Where(item => item.PaneId != first.PaneId))
                Assert.False(first.X < second.X + second.Width && first.X + first.Width > second.X &&
                    first.Y < second.Y + second.Height && first.Y + first.Height > second.Y);
        }
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void AddingPanesReflowsInsideTheSameViewportWithoutChangingRememberedWindowSize()
    {
        var document = FloatingWorkspace(1);
        document.MainWindow.Width = 1220;
        document.MainWindow.Height = 1100;
        for (var count = 2; count <= 8; count++)
        {
            var tab = document.Workspace.Tabs[0];
            document = WorkspaceCommands.Apply(document,
                Request("addPane", new PaneCreation(tab.Id, tab.ActivePaneId, null, null, new())));
            document = WorkspaceCommands.Apply(document,
                Request("workspaceViewport", new WorkspaceViewport(1200, 900, 1220)));
            var placements = document.Workspace.Tabs[0].Floating;
            Assert.Equal(count, placements.Count);
            Assert.Equal(1220, document.MainWindow.Width);
            Assert.Equal(1100, document.MainWindow.Height);
            Assert.Single(placements.Select(pane => pane.Width).Distinct());
            Assert.Single(placements.Select(pane => pane.Height).Distinct());
            Assert.All(placements, pane => Assert.True(pane.X + pane.Width <= 1190 && pane.Y + pane.Height <= 890));
        }
    }

    [Theory]
    [InlineData(double.NaN, 900)]
    [InlineData(1200, double.PositiveInfinity)]
    [InlineData(0, 900)]
    [InlineData(1200, -1)]
    [InlineData(100001, 900)]
    public void InvalidViewportIsRejectedWithoutChangingTheOriginal(double width, double height)
    {
        var document = FloatingWorkspace(2);
        var before = JsonSerializer.Serialize(document, WorkspaceJson.Options);
        Assert.Throws<InvalidDataException>(() => FloatingLayout.Arrange(document.Workspace.Tabs[0], width, height));
        Assert.Equal(before, JsonSerializer.Serialize(document, WorkspaceJson.Options));
    }

    [Theory]
    [InlineData(0, 900, 1200)]
    [InlineData(1200, 900, 0)]
    [InlineData(1200, 900, 100001)]
    public void InvalidViewportCommandFailsTransactionally(double width, double height, double browserWidth)
    {
        var document = FloatingWorkspace(2);
        var before = JsonSerializer.Serialize(document, WorkspaceJson.Options);
        Assert.Throws<InvalidDataException>(() => WorkspaceCommands.Apply(document,
            Request("workspaceViewport", new WorkspaceViewport(width, height, browserWidth))));
        Assert.Equal(before, JsonSerializer.Serialize(document, WorkspaceJson.Options));
    }

    [Fact]
    public void FreePositioningAndTiledOnlyTabsAreNotRearranged()
    {
        var document = FloatingWorkspace(2);
        var tab = document.Workspace.Tabs[0];
        tab.AutoArrangeFloating = false;
        var bounds = JsonSerializer.Serialize(tab, WorkspaceJson.Options);
        Assert.False(FloatingLayout.Arrange(tab, 900, 600));
        Assert.Equal(bounds, JsonSerializer.Serialize(tab, WorkspaceJson.Options));
        Assert.False(WorkspaceLayout.Duplicate(tab).AutoArrangeFloating);
        var tiled = WorkspaceDefaults.Create().Workspace.Tabs[0];
        var root = tiled.Root;
        Assert.False(FloatingLayout.Arrange(tiled, 900, 600));
        Assert.Same(root, tiled.Root);
    }

    [Fact]
    public void FloatingAndDockingPreserveCreationOrderAndDockToggleDisablesAutomaticReflow()
    {
        var document = WorkspaceDefaults.Create();
        var tab = document.Workspace.Tabs[0];
        WorkspaceLayout.AddPane(tab, new(), floating: false);
        WorkspaceLayout.AddPane(tab, new(), floating: false);
        var ids = tab.Panes.Select(pane => pane.Id).ToArray();
        WorkspaceLayout.ToggleFloating(tab, ids[0]);
        FloatingLayout.Arrange(tab, 1900, 900);
        Assert.Equal(ids, tab.Panes.Select(pane => pane.Id));
        Assert.Equal(ids, tab.Floating.Select(pane => pane.PaneId));
        WorkspaceLayout.ToggleFloating(tab, ids[1]);
        Assert.False(tab.AutoArrangeFloating);
        Assert.False(FloatingLayout.Arrange(tab, 1900, 900));
        Assert.DoesNotContain(tab.Floating, item => item.PaneId == ids[1]);
        WorkspaceLayout.Dock(tab, ids[0], ids[1], SplitAxis.Horizontal, false);
        Assert.Equal(ids, tab.Panes.Select(pane => pane.Id));
        Assert.DoesNotContain(tab.Floating, item => item.PaneId == ids[0]);
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void DuplicateFloatsButExplicitSplitAndDockOptOutOfAutomaticGrid()
    {
        var document = FloatingWorkspace(2);
        var tab = document.Workspace.Tabs[0];
        var first = tab.Panes[0].Id;
        document = WorkspaceCommands.Apply(document, Request("duplicatePane", new PaneSplit(first, SplitAxis.Horizontal)));
        Assert.Equal(3, document.Workspace.Tabs[0].Floating.Count);
        Assert.True(document.Workspace.Tabs[0].AutoArrangeFloating);
        document = WorkspaceCommands.Apply(document, Request("splitPane", new PaneSplit(first, SplitAxis.Vertical)));
        Assert.False(document.Workspace.Tabs[0].AutoArrangeFloating);
        var target = document.Workspace.Tabs[0].ActivePaneId;
        document = WorkspaceCommands.Apply(document, Request("dockPane", new PaneDock(first, target, SplitAxis.Horizontal, false)));
        Assert.DoesNotContain(document.Workspace.Tabs[0].Floating, item => item.PaneId == first);
        Assert.Equal(2, document.Workspace.Tabs[0].Floating.Count);
        WorkspaceValidator.Validate(document);
    }

    [Fact]
    public void TabOptionsCanReenableGridWithoutChangingUnrelatedPreferences()
    {
        var document = FloatingWorkspace(2);
        var tab = document.Workspace.Tabs[0];
        tab.AutoArrangeFloating = false;
        document = WorkspaceCommands.Apply(document, Request("renameTab",
            new TabProperties(tab.Id, tab.Name, tab.AccentColor, true)));
        document = WorkspaceCommands.Apply(document,
            Request("workspaceViewport", new WorkspaceViewport(1300, 700, 1320)));
        Assert.True(document.Workspace.Tabs[0].AutoArrangeFloating);
        Assert.Equal(10, document.Workspace.Tabs[0].Floating[0].X);
        Assert.False(document.Settings.PreventSleep);
    }

    [Fact]
    public async Task GridPositionsAndFreeLayoutChoiceRoundTripWithoutViewportRuntimeState()
    {
        var directory = Path.Combine(Path.GetTempPath(), "PromptTerminal-floating-" + Guid.NewGuid().ToString("N"));
        try
        {
            var document = FloatingWorkspace(4);
            FloatingLayout.Arrange(document.Workspace.Tabs[0], 1500, 800);
            document.Workspace.Tabs[0].AutoArrangeFloating = false;
            var store = new WorkspaceStore(Path.Combine(directory, "workspace.json"));
            await store.SaveAsync(document);
            var restored = (await store.LoadAsync())!;
            Assert.False(restored.Workspace.Tabs[0].AutoArrangeFloating);
            Assert.Equal(JsonSerializer.Serialize(document, WorkspaceJson.Options),
                JsonSerializer.Serialize(restored, WorkspaceJson.Options));
            Assert.DoesNotContain("browserWidth", await File.ReadAllTextAsync(store.Path));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }
}
