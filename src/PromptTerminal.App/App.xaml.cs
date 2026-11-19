using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using PromptTerminal.Core.Persistence;

namespace PromptTerminal.App;

public partial class App : Application
{
    private readonly List<Mutex> _instances = [];
    public static WorkspaceStorage Storage { get; private set; } =
        WorkspaceStorage.Resolve(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), []);
    public static string DataDirectory => Storage.DataDirectory;

    protected override void OnStartup(StartupEventArgs e)
    {
        string? directory = null;
        if (e.Args.Length > 0)
        {
            if (e.Args is not ["--data-directory", var argument] || !Path.IsPathFullyQualified(argument))
            {
                MessageBox.Show("Usage: PromptTerminal.App.exe [--data-directory <absolute directory>]",
                    "Prompt Terminal", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown(1);
                return;
            }
            directory = argument;
        }
        try
        {
            Storage = WorkspaceStorage.Resolve(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                [Environment.GetEnvironmentVariable("OneDrive"), Environment.GetEnvironmentVariable("OneDriveCommercial"),
                    Environment.GetEnvironmentVariable("OneDriveConsumer")], directory);
            var directories = Storage.IsOneDrive && Storage.UsesDefaultDirectory
                ? new[] { Storage.LocalDirectory, Storage.DataDirectory } : [Storage.DataDirectory];
            foreach (var path in directories.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (AcquireInstance(path)) continue;
                MessageBox.Show("Prompt Terminal is already open for this data directory or its original local workspace. " +
                    "Close that instance before migrating, or use another --data-directory.",
                    "Prompt Terminal", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown(0);
                return;
            }
            Storage.Initialize();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            MessageBox.Show("Workspace storage could not be initialized. Existing configuration was not overwritten.\n\n" +
                error.Message, "Prompt Terminal storage", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }
        base.OnStartup(e);
    }

    private bool AcquireInstance(string directory)
    {
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            Path.TrimEndingDirectorySeparator(directory).ToUpperInvariant())));
        var instance = new Mutex(false, @"Local\PromptTerminal-" + key);
        bool acquired;
        try { acquired = instance.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired)
        {
            instance.Dispose();
            return false;
        }
        _instances.Add(instance);
        return true;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        foreach (var instance in _instances)
        {
            instance.ReleaseMutex();
            instance.Dispose();
        }
        _instances.Clear();
        base.OnExit(e);
    }
}
