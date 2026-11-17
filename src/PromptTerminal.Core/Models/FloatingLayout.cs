namespace PromptTerminal.Core.Models;

public static class FloatingLayout
{
    public const double Inset = 10;
    public const double Gap = 12;
    public const double MinimumWidth = 280;
    public const double MinimumHeight = 180;
    public const double PreferredWidth = 600;

    public static double PreferredWorkspaceWidth(int count) =>
        count <= 0 ? 0 : Inset * 2 + count * PreferredWidth + (count - 1) * Gap;

    public static bool Arrange(WorkspaceTab tab, double width, double height)
    {
        if (!double.IsFinite(width) || !double.IsFinite(height) ||
            width is < 1 or > 100_000 || height is < 1 or > 100_000)
            throw new InvalidDataException("Workspace viewport dimensions must be between 1 and 100,000 pixels.");
        if (!tab.AutoArrangeFloating || tab.Floating.Count == 0) return false;

        var changed = false;
        if (tab.Root is not null)
        {
            var placements = tab.Floating.ToDictionary(item => item.PaneId);
            var z = tab.Floating.Max(item => item.Z);
            tab.Floating = tab.Panes.Select(pane => placements.GetValueOrDefault(pane.Id)
                ?? new FloatingPane { PaneId = pane.Id, Z = ++z }).ToList();
            tab.Root = null;
            changed = true;
        }

        var count = tab.Floating.Count;
        var usableWidth = Math.Max(MinimumWidth, width - Inset * 2);
        var usableHeight = Math.Max(MinimumHeight, height - Inset * 2);
        var maximumColumns = Math.Min(count, Math.Max(1, (int)((usableWidth + Gap) / (MinimumWidth + Gap))));
        var maximumRows = Math.Max(1, (int)((usableHeight + Gap) / (MinimumHeight + Gap)));
        var preferredColumns = Math.Max(1, (int)((usableWidth + Gap) / (PreferredWidth + Gap)));
        var columns = Math.Min(maximumColumns, Math.Max(preferredColumns, (int)Math.Ceiling((double)count / maximumRows)));
        var rows = (int)Math.Ceiling((double)count / columns);
        var cellWidth = Math.Floor((usableWidth - (columns - 1) * Gap) / columns);
        var cellHeight = Math.Max(MinimumHeight, Math.Floor((usableHeight - (rows - 1) * Gap) / rows));

        for (var index = 0; index < count; index++)
        {
            var pane = tab.Floating[index];
            var x = Inset + index % columns * (cellWidth + Gap);
            var y = Inset + index / columns * (cellHeight + Gap);
            changed |= pane.X != x || pane.Y != y || pane.Width != cellWidth || pane.Height != cellHeight;
            pane.X = x;
            pane.Y = y;
            pane.Width = cellWidth;
            pane.Height = cellHeight;
        }
        return changed;
    }
}
