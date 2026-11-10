using PromptTerminal.Core.Terminal;

namespace PromptTerminal.Core.Models;

public static class WorkspaceDefaults
{
    public static ApplicationDocument Create()
    {
        var document = new ApplicationDocument();
        var profile = new LaunchProfile { Executable = ShellLauncher.FindDefaultShell() };
        document.Profiles.Add(profile);
        var tab = WorkspaceLayout.AddTab(document.Workspace, "My workspace");
        WorkspaceLayout.AddPane(tab, new PaneDefinition
        {
            Name = "PowerShell",
            Profile = WorkspaceJson.Clone(profile)
        });
        document.Snippets.AddRange([
            new PromptSnippet { Name = "Review changes", Text = "Review the current changes for correctness and regressions. Run the relevant tests and summarize the findings." },
            new PromptSnippet { Name = "Implement and verify", Text = "Implement the requested change, preserve existing behavior, and run focused tests. Report any remaining limitations." },
            new PromptSnippet { Name = "Summarize progress", Text = "Summarize completed work, changed files, test results, and remaining blockers." }
        ]);
        var team = new WorkspaceTab { Name = "Agent team" };
        foreach (var name in new[] { "Planner", "Implementer", "Reviewer", "Tests" })
        {
            var agent = WorkspaceJson.Clone(profile);
            agent.Id = Guid.NewGuid();
            agent.Name = name;
            if (name == "Tests") agent.StartupScript = "dotnet test";
            WorkspaceLayout.AddPane(team, new PaneDefinition { Name = name, Profile = agent },
                axis: name == "Reviewer" ? SplitAxis.Vertical : SplitAxis.Horizontal);
        }
        document.Templates.Add(new TabTemplate { Name = "Agent team", Tab = team });
        return document;
    }
}
