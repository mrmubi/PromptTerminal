using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;
using PromptTerminal.Core.Models;

namespace PromptTerminal.Core.Terminal;

public sealed record SessionMetrics(double CpuPercent, long WorkingSetBytes);

[SupportedOSPlatform("windows")]
public sealed class ConPtySession : IAsyncDisposable
{
    private readonly Channel<string> _output = Channel.CreateBounded<string>(new BoundedChannelOptions(32)
    {
        SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait
    });
    private readonly Channel<string> _input = Channel.CreateBounded<string>(new BoundedChannelOptions(32)
    {
        SingleReader = true, FullMode = BoundedChannelFullMode.Wait
    });
    private readonly CancellationTokenSource _stop = new();
    private readonly object _consoleLock = new();
    private SafeFileHandle? _inputPipe, _outputPipe, _job;
    private SafeProcessHandle? _process;
    private IntPtr _console;
    private Task _reader = Task.CompletedTask, _writer = Task.CompletedTask;
    private Task<int>? _completion;
    private int _disposing;
    private TimeSpan _lastCpu;
    private long _lastSample = Stopwatch.GetTimestamp();

    private ConPtySession() { }
    public int ProcessId { get; private set; }
    public string Executable { get; private set; } = "";
    public ChannelReader<string> Output => _output.Reader;
    public Task<int> Completion => _completion ?? throw new InvalidOperationException("The session has not started.");
    public bool IsRunning => _completion is { IsCompleted: false } && !_stop.IsCancellationRequested;

    public static async Task<ConPtySession> StartAsync(LaunchProfile profile, Guid paneId,
        string? signalPipe = null, int columns = 100, int rows = 30)
    {
        var launch = await Task.Run(() => ShellLauncher.Build(profile, paneId, signalPipe));
        var session = new ConPtySession();
        var success = false;
        try
        {
            await Task.Run(() => session.Initialize(launch, columns, rows));
            success = true;
            return session;
        }
        finally
        {
            if (!success) await session.DisposeAsync();
        }
    }

    public ValueTask WriteAsync(string input, CancellationToken cancellationToken = default)
    {
        if (!IsRunning) throw new InvalidOperationException("The PowerShell session is not running.");
        if (input.Length > 1_048_576) throw new InvalidDataException("Input exceeds the 1 MiB per-message limit.");
        return _input.Writer.WriteAsync(input, cancellationToken);
    }

    public void Resize(int columns, int rows)
    {
        if (columns is < 2 or > 1000 || rows is < 1 or > 1000)
            throw new ArgumentOutOfRangeException(nameof(columns), "Terminal dimensions are outside the supported range.");
        lock (_consoleLock)
        {
            if (_console == IntPtr.Zero) return;
            Marshal.ThrowExceptionForHR(NativeConsole.ResizePseudoConsole(_console, new((short)columns, (short)rows)));
        }
    }

    public SessionMetrics? SampleMetrics()
    {
        if (!IsRunning) return null;
        try
        {
            using var process = Process.GetProcessById(ProcessId);
            var cpu = process.TotalProcessorTime;
            var now = Stopwatch.GetTimestamp();
            var elapsed = Stopwatch.GetElapsedTime(_lastSample, now).TotalMilliseconds;
            var percent = elapsed > 0 ? (cpu - _lastCpu).TotalMilliseconds / elapsed / System.Environment.ProcessorCount * 100 : 0;
            _lastCpu = cpu;
            _lastSample = now;
            return new(Math.Clamp(percent, 0, 100), process.WorkingSet64);
        }
        catch (ArgumentException) when (!IsRunning) { return null; }
        catch (InvalidOperationException) when (!IsRunning) { return null; }
    }

    public bool ContainsProcess(int processId)
    {
        using var process = Process.GetProcessById(processId);
        if (!NativeConsole.IsProcessInJob(process.SafeHandle, _job!, out var contained))
            throw NativeError("Inspect session process ownership");
        return contained;
    }

    private void Initialize(ShellLaunch launch, int columns, int rows)
    {
        Executable = launch.Executable;
        if (!NativeConsole.CreatePipe(out var inputRead, out var inputWrite, IntPtr.Zero, 0)) throw NativeError("Create terminal input pipe");
        _inputPipe = inputWrite;
        using (inputRead)
        {
            if (!NativeConsole.CreatePipe(out var outputRead, out var outputWrite, IntPtr.Zero, 0)) throw NativeError("Create terminal output pipe");
            _outputPipe = outputRead;
            using (outputWrite)
            {
                Marshal.ThrowExceptionForHR(NativeConsole.CreatePseudoConsole(new((short)columns, (short)rows),
                    inputRead, outputWrite, 0, out _console));
            }
        }

        _job = NativeConsole.CreateJobObject(IntPtr.Zero, null);
        if (_job.IsInvalid) throw NativeError("Create session process group");
        var limits = new NativeConsole.ExtendedLimitInformation
        {
            BasicLimitInformation = new() { LimitFlags = 0x2000 }
        };
        if (!NativeConsole.SetInformationJobObject(_job, 9, ref limits, (uint)Marshal.SizeOf<NativeConsole.ExtendedLimitInformation>()))
            throw NativeError("Configure session process group");
        nuint attributeSize = 0;
        NativeConsole.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
        var attributes = Marshal.AllocHGlobal(checked((int)attributeSize));
        var desktopPolicy = Marshal.AllocHGlobal(sizeof(uint));
        Marshal.WriteInt32(desktopPolicy, 0x02);
        var environment = Marshal.StringToHGlobalUni(string.Join('\0',
            launch.Environment.OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase).Select(p => p.Key + "=" + p.Value)) + "\0\0");
        var initialized = false;
        try
        {
            if (!NativeConsole.InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize)) throw NativeError("Initialize process attributes");
            initialized = true;
            if (!NativeConsole.UpdateProcThreadAttribute(attributes, 0, 0x20016, _console, (nuint)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw NativeError("Attach pseudoconsole");
            // Store-packaged shells otherwise break descendant processes out of their inherited jobs.
            if (!NativeConsole.UpdateProcThreadAttribute(attributes, 0, 0x20012, desktopPolicy, sizeof(uint), IntPtr.Zero, IntPtr.Zero))
                throw NativeError("Preserve packaged-shell child process ownership");
            var startup = new NativeConsole.StartupInfoEx
            {
                // Null standard handles prevent redirected parent handles from bypassing ConPTY.
                StartupInfo = new() { Size = Marshal.SizeOf<NativeConsole.StartupInfoEx>(), Flags = 0x100 },
                AttributeList = attributes
            };
            if (!NativeConsole.CreateProcess(launch.Executable, new($"\"{launch.Executable}\" {launch.Arguments}"),
                IntPtr.Zero, IntPtr.Zero, false, 0x80000 | 0x400 | 0x4, environment, launch.WorkingDirectory, ref startup, out var process))
                throw NativeError("Start PowerShell");
            _process = new SafeProcessHandle(process.Process, true);
            ProcessId = process.ProcessId;
            using var thread = new SafeFileHandle(process.Thread, true);
            // Assign while suspended: packaged PowerShell rejects the creation-time job-list attribute.
            if (!NativeConsole.AssignProcessToJobObject(_job, _process))
            {
                var error = NativeError("Contain PowerShell in its session process group");
                if (!NativeConsole.TerminateProcess(_process, 1))
                    throw new AggregateException(error, NativeError("Stop uncontained PowerShell"));
                throw error;
            }
            _reader = Task.Factory.StartNew(ReadOutput, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            _writer = Task.Factory.StartNew(WriteInput, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            if (NativeConsole.ResumeThread(thread) == uint.MaxValue) throw NativeError("Resume PowerShell");
            _completion = Task.Run(MonitorExit);
        }
        finally
        {
            if (initialized) NativeConsole.DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(desktopPolicy);
            Marshal.FreeHGlobal(environment);
        }
    }

    private void ReadOutput()
    {
        var bytes = new byte[16_384];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        Exception? error = null;
        try
        {
            while (true)
            {
                if (!NativeConsole.ReadFile(_outputPipe!, bytes, (uint)bytes.Length, out var count, IntPtr.Zero))
                {
                    var code = Marshal.GetLastWin32Error();
                    if (code is 109 or 232 || (code is 6 or 995 && _stop.IsCancellationRequested)) break;
                    throw new Win32Exception(code, "Reading terminal output failed.");
                }
                if (count == 0) break;
                var written = decoder.GetChars(bytes, 0, (int)count, chars, 0, false);
                if (written == 0 || _stop.IsCancellationRequested) continue;
                try { _output.Writer.WriteAsync(new string(chars, 0, written), _stop.Token).AsTask().GetAwaiter().GetResult(); }
                catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            }
        }
        catch (Win32Exception exception) { error = exception; }
        finally { _output.Writer.TryComplete(error); }
    }

    private void WriteInput()
    {
        try
        {
            while (_input.Reader.WaitToReadAsync(_stop.Token).AsTask().GetAwaiter().GetResult())
            {
                while (_input.Reader.TryRead(out var text))
                {
                    var bytes = Encoding.UTF8.GetBytes(text);
                    var offset = 0;
                    while (offset < bytes.Length)
                    {
                        var remaining = offset == 0 ? bytes : bytes[offset..];
                        if (!NativeConsole.WriteFile(_inputPipe!, remaining, (uint)remaining.Length, out var count, IntPtr.Zero))
                        {
                            var code = Marshal.GetLastWin32Error();
                            if (_stop.IsCancellationRequested && code is 6 or 109 or 232 or 995) return;
                            throw new Win32Exception(code, "Writing terminal input failed.");
                        }
                        if (count == 0) throw new IOException("The terminal input pipe stopped accepting data.");
                        offset += (int)count;
                    }
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
    }

    private async Task<int> MonitorExit()
    {
        if (NativeConsole.WaitForSingleObject(_process!, uint.MaxValue) != 0) throw NativeError("Wait for PowerShell exit");
        if (!NativeConsole.GetExitCodeProcess(_process!, out var code)) throw NativeError("Read PowerShell exit code");
        if (!NativeConsole.TerminateJobObject(_job!, code)) throw NativeError("Close remaining session processes");
        await CloseConsoleAsync();
        await _reader;
        _input.Writer.TryComplete();
        _stop.Cancel();
        await _writer;
        return unchecked((int)code);
    }

    private Task CloseConsoleAsync()
    {
        IntPtr console;
        lock (_consoleLock)
        {
            console = _console;
            _console = IntPtr.Zero;
        }
        return console == IntPtr.Zero ? Task.CompletedTask : Task.Run(() => NativeConsole.ClosePseudoConsole(console));
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposing, 1) != 0) return;
        _stop.Cancel();
        _input.Writer.TryComplete();
        try
        {
            if (_job is { IsInvalid: false, IsClosed: false } && !NativeConsole.TerminateJobObject(_job, 1))
                throw NativeError("Stop session process group");
            await CloseConsoleAsync();
            await Task.WhenAll(_reader, _writer);
            if (_completion is not null) await _completion;
        }
        finally
        {
            _inputPipe?.Dispose();
            _outputPipe?.Dispose();
            _process?.Dispose();
            _job?.Dispose();
            _output.Writer.TryComplete();
            _stop.Dispose();
        }
    }

    private static Win32Exception NativeError(string operation)
    {
        var code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, $"{operation} failed ({code}): {new Win32Exception(code).Message}");
    }
}
