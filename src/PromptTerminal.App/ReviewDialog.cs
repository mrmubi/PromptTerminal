using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace PromptTerminal.App;

internal static class ReviewDialog
{
    public static bool Confirm(Window owner, string title, string text, bool dark, string accept = "Continue")
    {
        var foreground = new SolidColorBrush(dark ? Color.FromRgb(232, 237, 247) : Color.FromRgb(23, 34, 54));
        var background = new SolidColorBrush(dark ? Color.FromRgb(17, 24, 42) : Colors.White);
        var dialog = new Window
        {
            Owner = owner, Title = title, Icon = owner.Icon, Width = 740, Height = 500, MinWidth = 480, MinHeight = 300,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = background, Foreground = foreground, ShowInTaskbar = false
        };
        dialog.SourceInitialized += (_, _) => ApplyWindowTheme(dialog, dark);
        var grid = new Grid { Margin = new Thickness(20) };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition());
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.Children.Add(new TextBlock
        {
            Text = title, FontSize = 21, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 16)
        });
        var content = new TextBox
        {
            Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Consolas"),
            FontSize = 13, Background = background, Foreground = foreground, Padding = new Thickness(12),
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        Grid.SetRow(content, 1);
        grid.Children.Add(content);
        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 16, 0, 0)
        };
        var cancel = new Button
        {
            Content = "Cancel", IsCancel = true, IsDefault = true, Padding = new Thickness(18, 8, 18, 8),
            Background = background, Foreground = foreground, Margin = new Thickness(0, 0, 12, 0)
        };
        var confirm = new Button
        {
            Content = accept, Padding = new Thickness(18, 8, 18, 8), Background = background, Foreground = foreground
        };
        confirm.Click += (_, _) => dialog.DialogResult = true;
        buttons.Children.Add(cancel);
        buttons.Children.Add(confirm);
        Grid.SetRow(buttons, 2);
        grid.Children.Add(buttons);
        dialog.Content = grid;
        return dialog.ShowDialog() == true;
    }

    internal static void ApplyWindowTheme(Window window, bool dark)
    {
        var handle = new WindowInteropHelper(window).Handle;
        if (handle == IntPtr.Zero) return;
        var value = dark ? 1 : 0;
        Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(handle, 20, ref value, sizeof(int)));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
