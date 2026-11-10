using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace PromptTerminal.Core.Terminal;

public sealed record AgentSignal(string State, string Message);

public sealed class SessionSignalListener : IAsyncDisposable
{
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _loop;
    private int _disposing;
    public string PipeName { get; } = "PromptTerminal-" + Guid.NewGuid().ToString("N");

    public SessionSignalListener(Func<AgentSignal, Task> onSignal, Func<string, Task> onError)
    {
        _loop = ListenAsync(onSignal, onError);
    }

    private async Task ListenAsync(Func<AgentSignal, Task> onSignal, Func<string, Task> onError)
    {
        while (!_stop.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(_stop.Token);
                using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 1024, true);
                var buffer = new char[4097];
                var length = 0;
                while (length < buffer.Length)
                {
                    var count = await reader.ReadAsync(buffer.AsMemory(length, buffer.Length - length), _stop.Token);
                    if (count == 0) break;
                    length += count;
                    if (buffer.AsSpan(0, length).Contains('\n')) break;
                }
                if (length > 4096) throw new InvalidDataException("Integration message exceeds 4096 characters.");
                using var json = JsonDocument.Parse(new string(buffer, 0, length).Trim());
                var state = json.RootElement.GetProperty("state").GetString();
                var message = json.RootElement.GetProperty("message").GetString() ?? "";
                if (state is not ("working" or "waiting" or "completed" or "directory"))
                    throw new InvalidDataException("Integration message has an unsupported state.");
                if (message.Length > 2048) throw new InvalidDataException("Integration message text is too long.");
                await onSignal(new AgentSignal(state, message));
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (IOException exception) when (!_stop.IsCancellationRequested) { await onError(exception.Message); }
            catch (Exception exception) when (exception is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or DecoderFallbackException)
            {
                await onError("Invalid integration message: " + exception.Message);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposing, 1) != 0) return;
        _stop.Cancel();
        try { await _loop; }
        finally { _stop.Dispose(); }
    }
}
