using System.ComponentModel;
using System.Runtime.InteropServices;

namespace PromptTerminal.Core.Power;

public sealed class KeepAwakeController : IDisposable
{
    private readonly Func<bool, bool> _apply;
    public bool IsEnabled { get; private set; }

    public KeepAwakeController() : this(ApplyNative) { }
    public KeepAwakeController(Func<bool, bool> apply) => _apply = apply;

    public void SetEnabled(bool enabled)
    {
        if (enabled == IsEnabled) return;
        if (!_apply(enabled))
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                enabled ? "Windows could not enable keep-awake mode." : "Windows could not release keep-awake mode.");
        IsEnabled = enabled;
    }

    public void Dispose() => SetEnabled(false);

    private static bool ApplyNative(bool enabled)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Keep-awake mode requires Windows.");
        return SetThreadExecutionState(0x80000000u | (enabled ? 0x00000001u : 0)) != 0;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);
}
