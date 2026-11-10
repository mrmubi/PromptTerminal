using System.Diagnostics.CodeAnalysis;
using System.Text.RegularExpressions;

namespace PromptTerminal.Core.Models;

public static partial class WorkspaceValidator
{
    public static void Validate(ApplicationDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        Require(document.SchemaVersion == 1, "Unsupported application schema version.");
        Require(document.Settings is not null, "Settings are required.");
        Validate(document.Settings!);
        Require(document.Profiles is not null && document.Snippets is not null && document.Templates is not null,
            "Profiles, snippets, and templates must be arrays.");
        Validate(document.Workspace);
        Unique(document.Profiles!.Select(p => p.Id), "profile");
        foreach (var profile in document.Profiles) Validate(profile);
        Unique(document.Snippets!.Select(p => p.Id), "snippet");
        foreach (var snippet in document.Snippets)
        {
            Require(!string.IsNullOrWhiteSpace(snippet.Name) && snippet.Name.Length <= 100, "Invalid snippet name.");
            Require(snippet.Text is not null && snippet.Text.Length <= 100_000, "Snippet text is too large.");
        }
        Unique(document.Templates!.Select(p => p.Id), "template");
        foreach (var template in document.Templates)
        {
            Require(!string.IsNullOrWhiteSpace(template.Name), "A template name is required.");
            Validate(new WorkspaceDocument { Tabs = [template.Tab], ActiveTabId = template.Tab.Id });
        }
    }

    public static void Validate(AppSettings settings)
    {
        Require(Enum.IsDefined(settings.Theme), "Invalid theme.");
        Require(settings.FontSize is >= 10 and <= 32, "Font size must be between 10 and 32.");
        Require(!string.IsNullOrWhiteSpace(settings.FontFamily) && settings.FontFamily.Length <= 200,
            "A font family is required.");
        Require(settings.Scrollback is >= 100 and <= 50_000, "Scrollback must be between 100 and 50,000 lines.");
        Require(settings.Shortcuts is not null, "Shortcuts are required.");
        var allowed = new AppSettings().Shortcuts.Keys.ToHashSet(StringComparer.Ordinal);
        var combinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in settings.Shortcuts!)
        {
            Require(allowed.Contains(pair.Key), $"Unknown shortcut action: {pair.Key}.");
            Require(pair.Value is not null && ShortcutPattern().IsMatch(pair.Value), $"Invalid shortcut: {pair.Value}.");
            var parts = pair.Value!.Split('+');
            var modifiers = parts[..^1];
            Require(modifiers.Distinct(StringComparer.OrdinalIgnoreCase).Count() == modifiers.Length,
                "Shortcut modifiers must not repeat.");
            var normalized = string.Join('+', modifiers.Order(StringComparer.OrdinalIgnoreCase)) + "+" + parts[^1];
            Require(combinations.Add(normalized), "Shortcut combinations must be unique.");
        }
    }

    public static void Validate(LaunchProfile profile)
    {
        Require(profile is not null, "A launch profile is required.");
        Require(profile!.Id != Guid.Empty, "A profile ID is required.");
        Require(!string.IsNullOrWhiteSpace(profile.Name) && profile.Name.Length <= 100, "Invalid profile name.");
        Require(!string.IsNullOrWhiteSpace(profile.Executable) && profile.Executable.Length <= 4096,
            "A shell executable is required.");
        Require(!string.IsNullOrWhiteSpace(profile.WorkingDirectory) && profile.WorkingDirectory.Length <= 4096,
            "A working directory is required.");
        Require(profile.StartupScript is not null && profile.StartupScript.Length <= 100_000 &&
                profile.ResumeScript is not null && profile.ResumeScript.Length <= 100_000, "Startup or resume script is too large.");
        Require(ColorPattern().IsMatch(profile.AccentColor), "Accent colors must use #RRGGBB.");
        Require(profile.Environment is not null, "Environment overrides are required.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in profile.Environment!)
        {
            Require(!string.IsNullOrWhiteSpace(pair.Key) && pair.Key.IndexOfAny(['=', '\0']) < 0 &&
                    pair.Value is not null && !pair.Value.Contains('\0'), "Invalid environment variable.");
            Require(names.Add(pair.Key), "Duplicate environment variable names.");
            Require(!pair.Key.StartsWith("PROMPTTERMINAL_", StringComparison.OrdinalIgnoreCase),
                "PROMPTTERMINAL_ environment variables are reserved.");
        }
    }

    public static void Validate(WorkspaceDocument workspace)
    {
        Require(workspace is not null && workspace.SchemaVersion == 1, "Unsupported workspace schema version.");
        Require(workspace!.Tabs is not null && workspace.Tabs.Count is > 0 and <= 100,
            "A workspace must have 1 to 100 tabs.");
        Unique(workspace.Tabs!.Select(t => t.Id), "tab");
        Require(workspace.Tabs.Any(t => t.Id == workspace.ActiveTabId), "The selected tab does not exist.");
        var paneIds = new HashSet<Guid>();
        var nodeIds = new HashSet<Guid>();
        foreach (var tab in workspace.Tabs)
        {
            Require(!string.IsNullOrWhiteSpace(tab.Name) && tab.Name.Length <= 100, "Invalid tab name.");
            Require(ColorPattern().IsMatch(tab.AccentColor), "Invalid tab color.");
            Require(tab.Panes is not null && tab.Panes.Count <= 200 && tab.Floating is not null, "Invalid pane collection.");
            var tabIds = new HashSet<Guid>();
            foreach (var pane in tab.Panes!)
            {
                Require(pane.Id != Guid.Empty && paneIds.Add(pane.Id) && tabIds.Add(pane.Id), "Duplicate or empty pane ID.");
                Require(!string.IsNullOrWhiteSpace(pane.Name) && pane.Name.Length <= 100, "Invalid pane name.");
                Validate(pane.Profile);
                Require(pane.Plan is not null, "A launch plan is required.");
            }
            Require(tab.ActivePaneId is null || tabIds.Contains(tab.ActivePaneId.Value), "Invalid active pane.");
            var placements = new HashSet<Guid>();
            if (tab.Root is not null) ValidateNode(tab.Root, tabIds, placements, nodeIds, 0);
            foreach (var floating in tab.Floating!)
            {
                Require(tabIds.Contains(floating.PaneId) && placements.Add(floating.PaneId), "Invalid floating pane reference.");
                Require(double.IsFinite(floating.X) && double.IsFinite(floating.Y) &&
                        double.IsFinite(floating.Width) && double.IsFinite(floating.Height) &&
                        floating.X >= 0 && floating.Y >= 0 &&
                        floating.Width is >= 280 and <= 100_000 && floating.Height is >= 180 and <= 100_000 &&
                        floating.Z >= 0, "Invalid floating panel bounds.");
            }
            Require(placements.SetEquals(tabIds), "Every pane must have exactly one layout placement.");
        }
        var panes = workspace.Tabs.SelectMany(t => t.Panes).ToDictionary(p => p.Id);
        foreach (var pane in panes.Values)
        {
            var visited = new HashSet<Guid> { pane.Id };
            var current = pane;
            while (current.Plan.AfterPaneId is Guid dependency)
            {
                Require(panes.ContainsKey(dependency), "A launch dependency references a missing pane.");
                Require(visited.Add(dependency), "Launch dependencies must not contain cycles.");
                current = panes[dependency];
            }
        }
    }

    private static void ValidateNode(LayoutNode node, HashSet<Guid> panes, HashSet<Guid> placements,
        HashSet<Guid> nodeIds, int depth)
    {
        Require(depth < 40 && node.Id != Guid.Empty && nodeIds.Add(node.Id), "Invalid, duplicate, or deeply nested layout node.");
        if (node.PaneId is Guid paneId)
        {
            Require(node.First is null && node.Second is null && panes.Contains(paneId) && placements.Add(paneId),
                "Invalid or duplicate tiled pane reference.");
            return;
        }
        Require(node.First is not null && node.Second is not null && Enum.IsDefined(node.Axis) &&
                double.IsFinite(node.Ratio) && node.Ratio is >= 0.1 and <= 0.9, "Invalid split layout.");
        ValidateNode(node.First!, panes, placements, nodeIds, depth + 1);
        ValidateNode(node.Second!, panes, placements, nodeIds, depth + 1);
    }

    private static void Unique(IEnumerable<Guid> ids, string entity)
    {
        var seen = new HashSet<Guid>();
        foreach (var id in ids) Require(id != Guid.Empty && seen.Add(id), $"Duplicate or empty {entity} ID.");
    }

    private static void Require([DoesNotReturnIf(false)] bool condition, string message)
    {
        if (!condition) throw new InvalidDataException(message);
    }

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();
    [GeneratedRegex("^(?:(?:Ctrl|Alt|Shift)\\+)+(?:[A-Za-z0-9]|Tab|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Enter|F[1-9]|F1[0-2])$")]
    private static partial Regex ShortcutPattern();
}
