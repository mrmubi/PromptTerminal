using System.Text.Json;

namespace PromptTerminal.Core.Models;

public sealed record BridgeRequest(int Version, string Id, string Type, Guid? PaneId, long? Generation, JsonElement Data)
{
    public static JsonSerializerOptions JsonOptions { get; } = new(WorkspaceJson.Options)
    {
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true
    };

    public static BridgeRequest Parse(string json)
    {
        if (json.Length > 12 * 1024 * 1024) throw new InvalidDataException("Renderer message exceeds 12 MiB.");
        var request = JsonSerializer.Deserialize<BridgeRequest>(json, JsonOptions)
            ?? throw new InvalidDataException("Renderer message is empty.");
        if (request.Version != 1 || string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 64 ||
            string.IsNullOrWhiteSpace(request.Type) || request.Type.Length > 64 || request.Data.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Invalid renderer message envelope.");
        return request;
    }

    public T Read<T>() where T : class => Data.Deserialize<T>(JsonOptions)
        ?? throw new InvalidDataException("Command data is required.");
}

public sealed record TabReference(Guid TabId);
public sealed record PaneReference(Guid PaneId);
public sealed record ItemReference(Guid Id);
public sealed record NewTabOptions(string Name);
public sealed record TabProperties(Guid TabId, string Name, string AccentColor);
public sealed record TabOrder(Guid TabId, int Index);
public sealed record PaneCreation(Guid TabId, Guid? TargetPaneId, SplitAxis? Axis, bool? Floating, PaneDefinition Pane);
public sealed record PaneSplit(Guid PaneId, SplitAxis Axis);
public sealed record PaneEdit(Guid PaneId, string Name, LaunchProfile Profile, bool ReadOnly, LaunchPlan Plan);
public sealed record PaneMove(Guid PaneId, Guid TabId);
public sealed record PaneDock(Guid PaneId, Guid? TargetPaneId, SplitAxis Axis, bool Before);
public sealed record SplitResize(Guid TabId, Guid NodeId, double Ratio);
public sealed record FloatingBounds(Guid PaneId, double X, double Y, double Width, double Height);
public sealed record TemplateCreation(Guid TabId, string Name);

public static class WorkspaceCommands
{
    public static ApplicationDocument Apply(ApplicationDocument original, BridgeRequest request)
    {
        var document = WorkspaceJson.Clone(original);
        var workspace = document.Workspace;
        switch (request.Type)
        {
            case "newTab":
            {
                var options = request.Read<NewTabOptions>();
                var tab = WorkspaceLayout.AddTab(workspace, options.Name);
                WorkspaceLayout.AddPane(tab, DefaultPane(document));
                break;
            }
            case "renameTab":
            {
                var options = request.Read<TabProperties>();
                var tab = FindTab(workspace, options.TabId);
                tab.Name = options.Name;
                tab.AccentColor = options.AccentColor;
                break;
            }
            case "reorderTab":
            {
                var options = request.Read<TabOrder>();
                var tab = FindTab(workspace, options.TabId);
                if (options.Index < 0 || options.Index >= workspace.Tabs.Count)
                    throw new InvalidDataException("Tab position is outside the workspace.");
                workspace.Tabs.Remove(tab);
                workspace.Tabs.Insert(options.Index, tab);
                break;
            }
            case "selectTab":
                workspace.ActiveTabId = FindTab(workspace, request.Read<TabReference>().TabId).Id;
                break;
            case "closeTab":
            {
                var tab = FindTab(workspace, request.Read<TabReference>().TabId);
                var index = workspace.Tabs.IndexOf(tab);
                workspace.Tabs.Remove(tab);
                WorkspaceLayout.RemoveDependencies(workspace, tab.Panes.Select(p => p.Id).ToHashSet());
                if (workspace.Tabs.Count == 0) WorkspaceLayout.AddTab(workspace);
                else if (workspace.ActiveTabId == tab.Id)
                    workspace.ActiveTabId = workspace.Tabs[Math.Min(index, workspace.Tabs.Count - 1)].Id;
                break;
            }
            case "duplicateTab":
            {
                var tab = WorkspaceLayout.Duplicate(FindTab(workspace, request.Read<TabReference>().TabId));
                workspace.Tabs.Add(tab);
                workspace.ActiveTabId = tab.Id;
                break;
            }
            case "addPane":
            {
                var options = request.Read<PaneCreation>();
                var pane = options.Pane;
                pane.Id = Guid.NewGuid();
                pane.Profile.Id = Guid.NewGuid();
                WorkspaceLayout.AddPane(FindTab(workspace, options.TabId), pane, options.TargetPaneId, options.Axis, options.Floating);
                break;
            }
            case "splitPane":
            {
                var options = request.Read<PaneSplit>();
                var (tab, source) = FindPane(workspace, options.PaneId);
                var pane = WorkspaceJson.Clone(source);
                pane.Id = Guid.NewGuid();
                pane.Profile.Id = Guid.NewGuid();
                pane.Name = source.Name[..Math.Min(source.Name.Length, 90)] + " copy";
                pane.Plan = new();
                WorkspaceLayout.AddPane(tab, pane, source.Id, options.Axis, floating: false);
                break;
            }
            case "editPane":
            {
                var options = request.Read<PaneEdit>();
                var (_, pane) = FindPane(workspace, options.PaneId);
                pane.Name = options.Name;
                pane.Profile = options.Profile;
                pane.ReadOnly = options.ReadOnly;
                pane.Plan = options.Plan;
                break;
            }
            case "focusPane":
            {
                var (tab, pane) = FindPane(workspace, request.Read<PaneReference>().PaneId);
                workspace.ActiveTabId = tab.Id;
                tab.ActivePaneId = pane.Id;
                var placements = tab.Floating.OrderBy(f => f.Z).ToList();
                var selected = placements.SingleOrDefault(f => f.PaneId == pane.Id);
                if (selected is not null)
                {
                    placements.Remove(selected);
                    placements.Add(selected);
                }
                for (var index = 0; index < placements.Count; index++) placements[index].Z = index + 1;
                break;
            }
            case "closePane":
            {
                var (tab, pane) = FindPane(workspace, request.Read<PaneReference>().PaneId);
                WorkspaceLayout.RemovePane(tab, pane.Id);
                WorkspaceLayout.RemoveDependencies(workspace, new HashSet<Guid> { pane.Id });
                break;
            }
            case "toggleFloat":
            {
                var (tab, pane) = FindPane(workspace, request.Read<PaneReference>().PaneId);
                WorkspaceLayout.ToggleFloating(tab, pane.Id);
                break;
            }
            case "dockPane":
            {
                var options = request.Read<PaneDock>();
                var (tab, pane) = FindPane(workspace, options.PaneId);
                WorkspaceLayout.Dock(tab, pane.Id, options.TargetPaneId, options.Axis, options.Before);
                break;
            }
            case "movePane":
            {
                var options = request.Read<PaneMove>();
                var (tab, pane) = FindPane(workspace, options.PaneId);
                var destination = FindTab(workspace, options.TabId);
                WorkspaceLayout.MovePane(tab, destination, pane.Id);
                workspace.ActiveTabId = destination.Id;
                break;
            }
            case "resizeSplit":
            {
                var options = request.Read<SplitResize>();
                var node = WorkspaceLayout.FindNode(FindTab(workspace, options.TabId).Root, options.NodeId);
                if (node is null || node.PaneId is not null) throw new InvalidDataException("The splitter no longer exists.");
                node.Ratio = options.Ratio;
                break;
            }
            case "floatingBounds":
            {
                var options = request.Read<FloatingBounds>();
                var (tab, _) = FindPane(workspace, options.PaneId);
                var bounds = tab.Floating.SingleOrDefault(f => f.PaneId == options.PaneId)
                    ?? throw new InvalidDataException("Only floating panels have movable bounds.");
                bounds.X = options.X;
                bounds.Y = options.Y;
                bounds.Width = options.Width;
                bounds.Height = options.Height;
                break;
            }
            case "readOnly":
            {
                var (_, pane) = FindPane(workspace, request.Read<PaneReference>().PaneId);
                pane.ReadOnly = !pane.ReadOnly;
                break;
            }
            case "settings":
                document.Settings = request.Read<AppSettings>();
                break;
            case "saveProfile":
            {
                var profile = request.Read<LaunchProfile>();
                document.Profiles.RemoveAll(p => p.Id == profile.Id);
                document.Profiles.Add(profile);
                break;
            }
            case "deleteProfile":
                if (document.Profiles.RemoveAll(p => p.Id == request.Read<ItemReference>().Id) == 0)
                    throw new InvalidDataException("The profile no longer exists.");
                break;
            case "saveSnippet":
            {
                var snippet = request.Read<PromptSnippet>();
                document.Snippets.RemoveAll(p => p.Id == snippet.Id);
                document.Snippets.Add(snippet);
                break;
            }
            case "deleteSnippet":
                if (document.Snippets.RemoveAll(p => p.Id == request.Read<ItemReference>().Id) == 0)
                    throw new InvalidDataException("The snippet no longer exists.");
                break;
            case "saveTemplate":
            {
                var options = request.Read<TemplateCreation>();
                document.Templates.Add(new TabTemplate
                {
                    Name = options.Name,
                    Tab = WorkspaceLayout.Duplicate(FindTab(workspace, options.TabId))
                });
                break;
            }
            case "applyTemplate":
            {
                var template = document.Templates.SingleOrDefault(t => t.Id == request.Read<ItemReference>().Id)
                    ?? throw new InvalidDataException("The template no longer exists.");
                var tab = WorkspaceLayout.Duplicate(template.Tab, template.Name);
                workspace.Tabs.Add(tab);
                workspace.ActiveTabId = tab.Id;
                break;
            }
            case "deleteTemplate":
                if (document.Templates.RemoveAll(p => p.Id == request.Read<ItemReference>().Id) == 0)
                    throw new InvalidDataException("The template no longer exists.");
                break;
            default:
                throw new InvalidDataException($"Unsupported workspace command: {request.Type}");
        }
        WorkspaceValidator.Validate(document);
        return document;
    }

    public static WorkspaceTab FindTab(WorkspaceDocument workspace, Guid id) =>
        workspace.Tabs.SingleOrDefault(t => t.Id == id) ?? throw new InvalidDataException("The tab no longer exists.");

    public static (WorkspaceTab Tab, PaneDefinition Pane) FindPane(WorkspaceDocument workspace, Guid id)
    {
        foreach (var tab in workspace.Tabs)
            if (tab.Panes.SingleOrDefault(p => p.Id == id) is { } pane) return (tab, pane);
        throw new InvalidDataException("The pane no longer exists.");
    }

    private static PaneDefinition DefaultPane(ApplicationDocument document) => new()
    {
        Profile = document.Profiles.Count > 0
            ? WorkspaceJson.Clone(document.Profiles[0])
            : WorkspaceDefaults.Create().Profiles[0]
    };
}
