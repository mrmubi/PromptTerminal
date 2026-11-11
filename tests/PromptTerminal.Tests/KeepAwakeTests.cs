using System.ComponentModel;
using PromptTerminal.Core.Power;

namespace PromptTerminal.Tests;

public sealed class KeepAwakeTests
{
    [Fact]
    public void PowerRequestChangesOnlyOnTransitionsAndIsReleasedOnDispose()
    {
        var applied = new List<bool>();
        var controller = new KeepAwakeController(enabled => { applied.Add(enabled); return true; });
        controller.SetEnabled(false);
        controller.SetEnabled(true);
        controller.SetEnabled(true);
        Assert.True(controller.IsEnabled);
        controller.Dispose();
        controller.Dispose();
        Assert.False(controller.IsEnabled);
        Assert.Equal(new[] { true, false }, applied);
    }

    [Fact]
    public void FailedPowerChangesAreExplicitAndDoNotClaimSuccess()
    {
        var succeed = false;
        var controller = new KeepAwakeController(_ => succeed);
        Assert.Throws<Win32Exception>(() => controller.SetEnabled(true));
        Assert.False(controller.IsEnabled);
        succeed = true;
        controller.SetEnabled(true);
        succeed = false;
        Assert.Throws<Win32Exception>(controller.Dispose);
        Assert.True(controller.IsEnabled);
        succeed = true;
        controller.Dispose();
    }
}
