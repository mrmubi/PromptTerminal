using PromptTerminal.Core.Models;

namespace PromptTerminal.Tests;

public sealed class RecurringScheduleTests
{
    private static readonly DateTimeOffset Wednesday = DateTimeOffset.Parse("2026-11-11T08:00:00Z");

    [Theory]
    [InlineData(ScheduleFrequency.Daily, "2026-11-11T09:00:00Z")]
    [InlineData(ScheduleFrequency.Weekdays, "2026-11-11T09:00:00Z")]
    [InlineData(ScheduleFrequency.Weekly, "2026-11-16T09:00:00Z")]
    [InlineData(ScheduleFrequency.Hourly, "2026-11-11T09:00:00Z")]
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

    [Theory]
    [InlineData("2026-11-11T08:29:45Z", null, "2026-11-11T09:00:00Z")]
    [InlineData("2026-11-11T09:00:00Z", null, "2026-11-11T10:00:00Z")]
    [InlineData("2026-11-11T09:59:59Z", null, "2026-11-11T10:00:00Z")]
    [InlineData("2026-11-11T23:59:59Z", null, "2026-11-12T00:00:00Z")]
    [InlineData("2026-11-13T23:15:00Z", null, "2026-11-14T00:00:00Z")]
    [InlineData("2026-11-11T08:29:45Z", "2026-11-11T11:00:00Z", "2026-11-11T11:00:00Z")]
    [InlineData("2026-11-11T08:29:45Z", "2026-11-11T11:00:01Z", "2026-11-11T12:00:00Z")]
    [InlineData("2026-11-11T08:29:45Z", "2026-12-05T13:15:00Z", "2026-12-05T14:00:00Z")]
    public void HourlyUsesTheNextHourBoundaryAndRespectsEarliestLaunch(
        string after, string? notBefore, string expected)
    {
        var schedule = new RecurringSchedule
        {
            Frequency = ScheduleFrequency.Hourly, Time = new(17, 35, 40), Day = DayOfWeek.Sunday
        };
        Assert.Equal(DateTimeOffset.Parse(expected), ScheduleCalculator.Next(schedule,
            DateTimeOffset.Parse(after), notBefore is null ? null : DateTimeOffset.Parse(notBefore), TimeZoneInfo.Utc));
    }

    [Fact]
    public void HourlyAlignsToLocalRatherThanUtcHoursInFractionalOffsetZones()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("Test+0530", TimeSpan.FromMinutes(330), "Test", "Test");
        var next = ScheduleCalculator.Next(new() { Frequency = ScheduleFrequency.Hourly },
            DateTimeOffset.Parse("2026-11-11T08:01:00Z"), timeZone: zone);
        Assert.Equal(DateTimeOffset.Parse("2026-11-11T08:30:00Z"), next);
        Assert.Equal(new TimeOnly(14, 0), TimeOnly.FromDateTime(TimeZoneInfo.ConvertTime(next, zone).DateTime));
    }

    [Theory]
    [InlineData("2026-03-08T06:30:00Z", "2026-03-08T07:00:00Z")]
    [InlineData("2026-11-01T04:30:00Z", "2026-11-01T05:00:00Z")]
    [InlineData("2026-11-01T05:30:00Z", "2026-11-01T06:00:00Z")]
    [InlineData("2026-11-01T06:00:00Z", "2026-11-01T07:00:00Z")]
    public void HourlySkipsMissingHoursAndIncludesBothRepeatedHourBoundaries(string after, string expected)
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
        Assert.Equal(DateTimeOffset.Parse(expected), ScheduleCalculator.Next(
            new() { Frequency = ScheduleFrequency.Hourly }, DateTimeOffset.Parse(after), timeZone: zone));
    }

    [Fact]
    public void HourlyLaunchesOncePerOccurrenceAndSkipsBusyOrMissedHoursWithoutCatchup()
    {
        var pane = new PaneDefinition
        {
            Plan = new() { Recurrence = new() { Frequency = ScheduleFrequency.Hourly } }
        };
        var armed = new ScheduledLaunch(pane, Wednesday.AddMinutes(29), TimeZoneInfo.Utc);
        Assert.Equal(Wednesday.AddHours(1), armed.NextRun);
        Assert.Equal(ScheduledRunDecision.Ready, armed.Consume(armed.NextRun, false));
        Assert.Equal(ScheduledRunDecision.NotDue, armed.Consume(Wednesday.AddHours(1), false));
        Assert.Equal(ScheduledRunDecision.SkippedBusy, armed.Consume(Wednesday.AddHours(2), true));
        Assert.Equal(ScheduledRunDecision.SkippedMissed, armed.Consume(Wednesday.AddHours(4).AddMinutes(5), false));
        Assert.Equal(Wednesday.AddHours(5), armed.NextRun);
        Assert.Equal(ScheduledRunDecision.Ready, armed.Consume(armed.NextRun.AddSeconds(15), false));
    }
}
