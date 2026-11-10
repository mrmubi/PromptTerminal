using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows;

namespace PromptTerminal.App;

public partial class App : Application
{
    private Mutex? _instance;
    public static string DataDirectory { get; private set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PromptTerminal");

    protected override void OnStartup(StartupEventArgs e)
    {
        if (e.Args.Length > 0)
        {
            if (e.Args is not ["--data-directory", var directory] || !Path.IsPathFullyQualified(directory))
            {
                MessageBox.Show("Usage: PromptTerminal.App.exe [--data-directory <absolute directory>]",
                    "Prompt Terminal", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown(1);
                return;
            }
            DataDirectory = Path.GetFullPath(directory);
        }
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.TrimEndingDirectorySeparator(DataDirectory).ToUpperInvariant())));
        _instance = new Mutex(false, @"Local\PromptTerminal-" + key);
        bool acquired;
        try { acquired = _instance.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired)
        {
            _instance.Dispose();
            _instance = null;
            MessageBox.Show("Prompt Terminal is already open for this data directory. Use the existing window, or choose another --data-directory.",
                "Prompt Terminal", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(0);
            return;
        }
        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_instance is not null)
        {
            _instance.ReleaseMutex();
            _instance.Dispose();
        }
        base.OnExit(e);
    }
}
