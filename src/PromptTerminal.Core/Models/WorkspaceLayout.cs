namespace PromptTerminal.Core.Models;

public static class WorkspaceLayout
{
    public static WorkspaceTab AddTab(WorkspaceDocument workspace, string name = "Workspace")
    {
        var tab = new WorkspaceTab { Name = name };
        workspace.Tabs.Add(tab);
        workspace.ActiveTabId = tab.Id;
        return tab;
    }

    public static void AddPane(WorkspaceTab tab, PaneDefinition pane, Guid? target = null,
        SplitAxis? axis = null, bool? floating = null, bool before = false)
    {
        if (tab.Panes.Any(p => p.Id == pane.Id)) throw new InvalidOperationException("The pane already belongs to this tab.");
        if (target is not null && !tab.Panes.Any(p => p.Id == target)) throw new InvalidOperationException("The target pane does not exist.");
        target ??= tab.ActivePaneId;
        var neighbor = tab.Floating.SingleOrDefault(f => f.PaneId == target)
            ?? tab.Floating.OrderBy(f => f.Z).LastOrDefault();
        if (floating ?? neighbor is not null)
        {
            tab.Floating.Add(new FloatingPane
            {
                PaneId = pane.Id,
                X = neighbor is null ? 40 : Math.Min(100_000, neighbor.X + neighbor.Width + 12),
                Y = neighbor?.Y ?? 40,
                Width = neighbor?.Width ?? 600,
                Height = neighbor?.Height ?? 360,
                Z = tab.Floating.Select(f => f.Z).DefaultIfEmpty(0).Max() + 1
            });
        }
        else
        {
            var leaf = LayoutNode.Leaf(pane.Id);
            if (tab.Root is null) tab.Root = leaf;
            else
            {
                var targetNode = target is Guid id ? FindLeaf(tab.Root, id) : null;
                targetNode ??= FirstLeaf(tab.Root);
                var oldLeaf = LayoutNode.Leaf(targetNode.PaneId!.Value);
                targetNode.PaneId = null;
                var inheritedAxis = FindParent(tab.Root, targetNode.Id)?.Axis ?? SplitAxis.Horizontal;
                targetNode.Axis = axis ?? inheritedAxis;
                targetNode.Ratio = 0.5;
                targetNode.First = before ? leaf : oldLeaf;
                targetNode.Second = before ? oldLeaf : leaf;
            }
        }
        tab.Panes.Add(pane);
        tab.ActivePaneId = pane.Id;
    }

    public static PaneDefinition RemovePane(WorkspaceTab tab, Guid id)
    {
        var pane = tab.Panes.SingleOrDefault(p => p.Id == id)
            ?? throw new InvalidOperationException("The pane does not exist.");
        tab.Panes.Remove(pane);
        tab.Root = RemoveNode(tab.Root, id);
        tab.Floating.RemoveAll(f => f.PaneId == id);
        if (tab.ActivePaneId == id) tab.ActivePaneId = tab.Panes.FirstOrDefault()?.Id;
        return pane;
    }

    public static void ToggleFloating(WorkspaceTab tab, Guid id)
    {
        var floating = tab.Floating.Any(f => f.PaneId == id);
        var pane = RemovePane(tab, id);
        AddPane(tab, pane, floating: !floating);
    }

    public static void Dock(WorkspaceTab tab, Guid id, Guid? target, SplitAxis axis, bool before)
    {
        if (id == target) throw new InvalidOperationException("A pane cannot dock into itself.");
        if (target is Guid targetId && FindLeaf(tab.Root, targetId) is null)
            throw new InvalidOperationException("Docking requires a tiled target pane.");
        var pane = RemovePane(tab, id);
        AddPane(tab, pane, target, axis, before: before);
    }

    public static void MovePane(WorkspaceTab source, WorkspaceTab destination, Guid id)
    {
        if (source.Id == destination.Id) return;
        var pane = RemovePane(source, id);
        AddPane(destination, pane);
    }

    public static LayoutNode? FindNode(LayoutNode? node, Guid id)
    {
        if (node is null || node.Id == id) return node;
        return FindNode(node.First, id) ?? FindNode(node.Second, id);
    }

    public static WorkspaceTab Duplicate(WorkspaceTab source, string? name = null)
    {
        var clone = WorkspaceJson.Clone(source);
        clone.Id = Guid.NewGuid();
        clone.Name = name ?? $"{source.Name} copy";
        var ids = clone.Panes.ToDictionary(p => p.Id, _ => Guid.NewGuid());
        foreach (var pane in clone.Panes)
        {
            pane.Id = ids[pane.Id];
            pane.Profile.Id = Guid.NewGuid();
            pane.Plan.AfterPaneId = pane.Plan.AfterPaneId is Guid dependency && ids.TryGetValue(dependency, out var mapped)
                ? mapped : null;
        }
        Remap(clone.Root, ids);
        foreach (var floating in clone.Floating) floating.PaneId = ids[floating.PaneId];
        clone.ActivePaneId = clone.ActivePaneId is Guid active ? ids[active] : null;
        return clone;
    }

    public static void RemoveDependencies(WorkspaceDocument workspace, ISet<Guid> removed)
    {
        foreach (var pane in workspace.Tabs.SelectMany(t => t.Panes))
            if (pane.Plan.AfterPaneId is Guid id && removed.Contains(id)) pane.Plan.AfterPaneId = null;
    }

    private static LayoutNode? FindLeaf(LayoutNode? node, Guid id) =>
        node is null ? null : node.PaneId == id ? node : FindLeaf(node.First, id) ?? FindLeaf(node.Second, id);
    private static LayoutNode FirstLeaf(LayoutNode node) => node.PaneId is not null ? node : FirstLeaf(node.First!);
    private static LayoutNode? FindParent(LayoutNode? node, Guid id) =>
        node is null ? null : node.First?.Id == id || node.Second?.Id == id ? node
            : FindParent(node.First, id) ?? FindParent(node.Second, id);

    private static LayoutNode? RemoveNode(LayoutNode? node, Guid id)
    {
        if (node is null || node.PaneId == id) return null;
        if (node.PaneId is not null) return node;
        node.First = RemoveNode(node.First, id);
        node.Second = RemoveNode(node.Second, id);
        if (node.First is null) return node.Second;
        if (node.Second is null) return node.First;
        return node;
    }

    private static void Remap(LayoutNode? node, Dictionary<Guid, Guid> ids)
    {
        if (node is null) return;
        node.Id = Guid.NewGuid();
        if (node.PaneId is Guid pane) node.PaneId = ids[pane];
        Remap(node.First, ids);
        Remap(node.Second, ids);
    }
}
