using System.Text.Json;
using System.Text.Json.Serialization;

namespace PromptTerminal.Core.Models;

public enum ThemePreference { System, Dark, Light }
public enum SplitAxis { Horizontal, Vertical }

public sealed class AppSettings
{
    public ThemePreference Theme { get; set; } = ThemePreference.System;
    public string FontFamily { get; set; } = "Cascadia Mono, Consolas, monospace";
    public int FontSize { get; set; } = 14;
    public int Scrollback { get; set; } = 10_000;
    public bool ScreenReaderMode { get; set; }
    public bool PreventSleep { get; set; }
    public Dictionary<string, string> Shortcuts { get; set; } = new()
    {
        ["newTab"] = "Ctrl+Shift+T",
        ["newPane"] = "Ctrl+Shift+N",
        ["splitHorizontal"] = "Ctrl+Shift+H",
        ["splitVertical"] = "Ctrl+Shift+J",
        ["nextTab"] = "Ctrl+Tab",
        ["previousTab"] = "Ctrl+Shift+Tab",
        ["nextPane"] = "Alt+ArrowRight",
        ["previousPane"] = "Alt+ArrowLeft",
        ["maximize"] = "Ctrl+Shift+M",
        ["toggleFloat"] = "Ctrl+Shift+F",
        ["palette"] = "Ctrl+Shift+P",
        ["search"] = "Ctrl+Shift+S"
    };
}

public sealed class LaunchProfile
{
    [JsonRequired]
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "PowerShell";
    public string Executable { get; set; } = "pwsh.exe";
    public string WorkingDirectory { get; set; } = System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);
    public string StartupScript { get; set; } = "";
    public string ResumeScript { get; set; } = "";
    public Dictionary<string, string> Environment { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public bool LoadUserProfile { get; set; } = true;
    public bool KeepShellOpen { get; set; } = true;
    public bool EnableIntegration { get; set; } = true;
    public string AccentColor { get; set; } = "#7C8AFF";
}

public sealed class LaunchPlan
{
    public DateTimeOffset? NotBefore { get; set; }
    public Guid? AfterPaneId { get; set; }
    public RecurringSchedule? Recurrence { get; set; }
}

public sealed class MainWindowPreferences
{
    public double Width { get; set; } = 1450;
    public double Height { get; set; } = 900;
    public bool Maximized { get; set; }
}

public sealed class PaneDefinition
{
    [JsonRequired]
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "PowerShell";
    [JsonRequired]
    public LaunchProfile Profile { get; set; } = new();
    public bool ReadOnly { get; set; }
    public LaunchPlan Plan { get; set; } = new();
}

public sealed class LayoutNode
{
    [JsonRequired]
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid? PaneId { get; set; }
    public SplitAxis Axis { get; set; }
    public double Ratio { get; set; } = 0.5;
    public LayoutNode? First { get; set; }
    public LayoutNode? Second { get; set; }

    public static LayoutNode Leaf(Guid paneId) => new() { PaneId = paneId };
}

public sealed class FloatingPane
{
    [JsonRequired]
    public Guid PaneId { get; set; }
    public double X { get; set; } = 40;
    public double Y { get; set; } = 40;
    public double Width { get; set; } = 600;
    public double Height { get; set; } = 360;
    public int Z { get; set; } = 1;
}

public sealed class WorkspaceTab
{
    [JsonRequired]
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "Workspace";
    public string AccentColor { get; set; } = "#7C8AFF";
    [JsonRequired]
    public List<PaneDefinition> Panes { get; set; } = [];
    public LayoutNode? Root { get; set; }
    public List<FloatingPane> Floating { get; set; } = [];
    public Guid? ActivePaneId { get; set; }
}

public sealed class WorkspaceDocument
{
    [JsonRequired]
    public int SchemaVersion { get; set; } = 1;
    [JsonRequired]
    public List<WorkspaceTab> Tabs { get; set; } = [];
    [JsonRequired]
    public Guid ActiveTabId { get; set; }
}

public sealed class PromptSnippet
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string Text { get; set; } = "";
}

public sealed class TabTemplate
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public WorkspaceTab Tab { get; set; } = new();
}

public sealed class ApplicationDocument
{
    [JsonRequired]
    public int SchemaVersion { get; set; } = 1;
    [JsonRequired]
    public WorkspaceDocument Workspace { get; set; } = new();
    public AppSettings Settings { get; set; } = new();
    public MainWindowPreferences MainWindow { get; set; } = new();
    public List<LaunchProfile> Profiles { get; set; } = [];
    public List<PromptSnippet> Snippets { get; set; } = [];
    public List<TabTemplate> Templates { get; set; } = [];
}

public static class WorkspaceJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = false,
            WriteIndented = true,
            MaxDepth = 64,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return options;
    }

    public static T Clone<T>(T value) where T : class =>
        JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, Options), Options)
        ?? throw new InvalidDataException("The saved document is empty.");
}
