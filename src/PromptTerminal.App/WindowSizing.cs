using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using PromptTerminal.Core.Models;

namespace PromptTerminal.App;

internal static class WindowSizing
{
    public static WorkspaceViewport GrowForPanes(Window window, FrameworkElement browser,
        WorkspaceViewport viewport, int count)
    {
        var missingWidth = FloatingLayout.PreferredWorkspaceWidth(count) - viewport.Width;
        if (missingWidth <= 0 || window.WindowState != WindowState.Normal) return viewport;
        var handle = new WindowInteropHelper(window).Handle;
        if (!GetWindowRect(handle, out var current)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Read main window bounds");
        var monitor = MonitorFromWindow(handle, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Read the current monitor work area");
        var dpi = GetDpiForWindow(handle);
        if (dpi == 0 || browser.ActualWidth <= 0)
            throw new InvalidOperationException("The main window is not ready to measure floating panel space.");
        var pixelsPerCssPixel = dpi / 96d * browser.ActualWidth / viewport.BrowserWidth;
        var width = Math.Min(info.Work.Right - info.Work.Left,
            current.Right - current.Left + (int)Math.Ceiling(missingWidth * pixelsPerCssPixel));
        if (width <= current.Right - current.Left) return viewport;
        var left = Math.Clamp(current.Left, info.Work.Left, info.Work.Right - width);
        if (!SetWindowPos(handle, IntPtr.Zero, left, current.Top, width, current.Bottom - current.Top, 0x14))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Grow the main window for floating panels");
        var added = (width - (current.Right - current.Left)) / pixelsPerCssPixel;
        return viewport with { Width = viewport.Width + added, BrowserWidth = viewport.BrowserWidth + added };
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public NativeRect Monitor, Work;
        public uint Flags;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr window, out NativeRect bounds);
    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
