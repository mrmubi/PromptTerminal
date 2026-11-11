namespace PromptTerminal.Core.Models;

public enum ScheduleFrequency { Daily, Weekdays, Weekly }
public enum ScheduledRunDecision { NotDue, Ready, SkippedBusy, SkippedMissed }

public sealed class RecurringSchedule
{
    public ScheduleFrequency Frequency { get; set; } = ScheduleFrequency.Daily;
    public TimeOnly Time { get; set; } = new(9, 0);
    public DayOfWeek Day { get; set; } = DayOfWeek.Monday;
}

public static class ScheduleCalculator
{
    public static DateTimeOffset Next(RecurringSchedule schedule, DateTimeOffset after,
        DateTimeOffset? notBefore = null, TimeZoneInfo? timeZone = null)
    {
        WorkspaceValidator.Validate(schedule);
        timeZone ??= TimeZoneInfo.Local;
        var earliest = notBefore > after ? notBefore.Value : after;
        var firstDate = TimeZoneInfo.ConvertTime(earliest, timeZone).Date;
        for (var index = 0; index < 15; index++)
        {
            var date = firstDate.AddDays(index);
            if (schedule.Frequency == ScheduleFrequency.Weekdays && date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ||
                schedule.Frequency == ScheduleFrequency.Weekly && date.DayOfWeek != schedule.Day)
                continue;
            var local = DateTime.SpecifyKind(date + schedule.Time.ToTimeSpan(), DateTimeKind.Unspecified);
            if (timeZone.IsInvalidTime(local)) continue;
            // Choose the earlier occurrence of an ambiguous wall time, once per date.
            var offset = timeZone.IsAmbiguousTime(local)
                ? timeZone.GetAmbiguousTimeOffsets(local).Max()
                : timeZone.GetUtcOffset(local);
            var candidate = new DateTimeOffset(local, offset);
            if (candidate > after && candidate >= earliest) return candidate;
        }
        throw new InvalidOperationException("No valid recurring launch time could be found within the next two weeks.");
    }
}

public sealed class ScheduledLaunch
{
    private readonly TimeZoneInfo _timeZone;
    public PaneDefinition Pane { get; }
    public DateTimeOffset NextRun { get; private set; }
    public DateTimeOffset? LastRun { get; private set; }
    public string Message { get; set; } = "Armed for this app session";

    public ScheduledLaunch(PaneDefinition reviewedPane, DateTimeOffset now, TimeZoneInfo? timeZone = null)
    {
        Pane = WorkspaceJson.Clone(reviewedPane);
        _timeZone = timeZone ?? TimeZoneInfo.Local;
        NextRun = ScheduleCalculator.Next(Pane.Plan.Recurrence
            ?? throw new InvalidDataException("Configure a recurrence before arming this pane."),
            now, Pane.Plan.NotBefore, _timeZone);
    }

    public ScheduledRunDecision Consume(DateTimeOffset now, bool busy)
    {
        if (now < NextRun) return ScheduledRunDecision.NotDue;
        var due = NextRun;
        NextRun = ScheduleCalculator.Next(Pane.Plan.Recurrence!, now, Pane.Plan.NotBefore, _timeZone);
        if (now - due > TimeSpan.FromMinutes(1)) return ScheduledRunDecision.SkippedMissed;
        if (busy) return ScheduledRunDecision.SkippedBusy;
        LastRun = due;
        return ScheduledRunDecision.Ready;
    }
}
