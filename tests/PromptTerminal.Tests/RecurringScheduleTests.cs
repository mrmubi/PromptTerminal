using PromptTerminal.Core.Models;

namespace PromptTerminal.Tests;

public sealed class RecurringScheduleTests
{
    private static readonly DateTimeOffset Wednesday = DateTimeOffset.Parse("2026-11-11T08:00:00Z");

    [Theory]
    [InlineData(ScheduleFrequency.Daily, "2026-11-11T09:00:00Z")]
    [InlineData(ScheduleFrequency.Weekdays, "2026-11-11T09:00:00Z")]
    [InlineData(ScheduleFrequency.Weekly, "2026-11-16T09:00:00Z")]
    public void NextOccurrenceUsesRequestedLocalTimeAndFrequency(ScheduleFrequency frequency, string expected)
    {
        var schedule = new RecurringSchedule { Frequency = frequency, Time = new(9, 0), Day = DayOfWeek.Monday };
        Assert.Equal(DateTimeOffset.Parse(expected), ScheduleCalculator.Next(schedule, Wednesday, timeZone: TimeZoneInfo.Utc));
    }

    [Fact]
    public void WeekdaysSkipTheWeekendAndNotBeforeCanBeWeeksAhead()
    {
        var schedule = new RecurringSchedule { Frequency = ScheduleFrequency.Weekdays };
        Assert.Equal(DateTimeOffset.Parse("2026-11-16T09:00:00Z"),
            ScheduleCalculator.Next(schedule, DateTimeOffset.Parse("2026-11-13T09:00:00Z"), timeZone: TimeZoneInfo.Utc));
        Assert.Equal(DateTimeOffset.Parse("2026-12-07T09:00:00Z"),
            ScheduleCalculator.Next(schedule, Wednesday, DateTimeOffset.Parse("2026-12-05T00:00:00Z"), TimeZoneInfo.Utc));
    }

    [Fact]
    public void RecurrenceUsesTheProvidedTimeZoneRatherThanUtcWallTime()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("Test+05", TimeSpan.FromHours(5), "Test", "Test");
        Assert.Equal(DateTimeOffset.Parse("2026-11-12T04:00:00Z"),
            ScheduleCalculator.Next(new(), Wednesday, timeZone: zone));
    }

    [Fact]
    public void SpringGapIsSkippedAndAutumnAmbiguousTimeRunsOnce()
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
        Assert.Equal(DateTimeOffset.Parse("2026-03-09T06:30:00Z"),
            ScheduleCalculator.Next(new() { Time = new(2, 30) },
                DateTimeOffset.Parse("2026-03-07T08:00:00Z"), timeZone: zone));
        var autumn = new RecurringSchedule { Time = new(1, 30) };
        var first = ScheduleCalculator.Next(autumn, DateTimeOffset.Parse("2026-11-01T04:00:00Z"), timeZone: zone);
        Assert.Equal(DateTimeOffset.Parse("2026-11-01T05:30:00Z"), first);
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T06:30:00Z"),
            ScheduleCalculator.Next(autumn, first, timeZone: zone));
    }

    [Fact]
    public void ArmedLaunchSnapshotsCodeAndConsumesEachOccurrenceOnce()
    {
        var pane = new PaneDefinition { Plan = new() { Recurrence = new() } };
        pane.Profile.StartupScript = "reviewed";
        var armed = new ScheduledLaunch(pane, Wednesday, TimeZoneInfo.Utc);
        pane.Profile.StartupScript = "unreviewed";
        pane.Plan.Recurrence.Time = new(12, 0);
        Assert.Equal("reviewed", armed.Pane.Profile.StartupScript);
        Assert.Equal(ScheduledRunDecision.NotDue, armed.Consume(Wednesday, false));
        var due = DateTimeOffset.Parse("2026-11-11T09:00:00Z");
        Assert.Equal(ScheduledRunDecision.Ready, armed.Consume(due, false));
        Assert.Equal(due, armed.LastRun);
        Assert.Equal(ScheduledRunDecision.NotDue, armed.Consume(due, false));
        Assert.Equal(DateTimeOffset.Parse("2026-11-12T09:00:00Z"), armed.NextRun);
    }

    [Fact]
    public void BusyAndMissedOccurrencesAreSkippedWithoutBackfillOrClockRollbackDuplicates()
    {
        var pane = new PaneDefinition { Plan = new() { Recurrence = new() } };
        var armed = new ScheduledLaunch(pane, Wednesday, TimeZoneInfo.Utc);
        var due = armed.NextRun;
        Assert.Equal(ScheduledRunDecision.SkippedBusy, armed.Consume(due, true));
        Assert.Null(armed.LastRun);
        Assert.Equal(ScheduledRunDecision.NotDue, armed.Consume(Wednesday, false));
        Assert.Equal(ScheduledRunDecision.SkippedMissed, armed.Consume(due.AddDays(4).AddMinutes(5), false));
        Assert.Equal(due.AddDays(5), armed.NextRun);
        Assert.Equal(ScheduledRunDecision.Ready, armed.Consume(armed.NextRun.AddSeconds(30), false));
    }

    [Fact]
    public void InvalidRecurrencesFailValidationAndMissingRecurrenceCannotArm()
    {
        Assert.Throws<InvalidDataException>(() => ScheduleCalculator.Next(
            new() { Frequency = (ScheduleFrequency)99 }, Wednesday));
        Assert.Throws<InvalidDataException>(() => ScheduleCalculator.Next(
            new() { Day = (DayOfWeek)99 }, Wednesday));
        Assert.Throws<InvalidDataException>(() => new ScheduledLaunch(new(), Wednesday));
    }
}
