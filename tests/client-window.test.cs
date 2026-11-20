using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using LocalChatResearch;

// A local native RichEdit fixture; never locates or sends to KakaoTalk.
public sealed class ChatWindowFixture : IDisposable
{
    delegate IntPtr Procedure(IntPtr window, uint message, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass { public uint style; public Procedure procedure; public int classExtra, windowExtra; public IntPtr instance, icon, cursor, background; public string menu, name; }
    [StructLayout(LayoutKind.Sequential)]
    struct Message { public IntPtr window; public uint message; public UIntPtr w; public IntPtr l; public uint time; public int x, y; public uint extra; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint extended, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr CallWindowProcW(IntPtr p, IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLong(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] static extern IntPtr Send(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryW(string name);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(IntPtr name);
    readonly Thread thread;
    readonly ManualResetEvent ready = new ManualResetEvent(false);
    readonly bool accept;
    readonly string initial;
    Procedure parentProcedure, inputProcedure;
    IntPtr parent, input, original;
    Exception startupError;
    public readonly string Title = "LocalChat native fixture " + Guid.NewGuid().ToString("N");
    public int Changes, EnterRequests, Submissions;
    public string Submitted;
    public bool Minimized { get { return IsIconic(parent); } }
    public bool Visible { get { return IsWindowVisible(parent); } }
    public static IntPtr Foreground { get { return GetForegroundWindow(); } }
    public ChatWindowFixture(bool accept, string initial)
    {
        this.accept = accept; this.initial = initial;
        thread = new Thread(Run); thread.SetApartmentState(ApartmentState.STA); thread.Start();
        if (!ready.WaitOne(5000)) throw new Exception("Fixture startup timed out.");
        if (startupError != null) throw startupError;
    }
    void Write(string text)
    {
        IntPtr data = Marshal.StringToHGlobalUni(text);
        try { Send(input, 0x000C, IntPtr.Zero, data); }
        finally { Marshal.FreeHGlobal(data); }
    }
    public string Read()
    {
        IntPtr data = Marshal.AllocHGlobal(8192);
        try { int copied = Send(input, 0x000D, new IntPtr(4096), data).ToInt32(); return Marshal.PtrToStringUni(data, copied); }
        finally { Marshal.FreeHGlobal(data); }
    }
    public void Type(string text)
    {
        IntPtr data = Marshal.StringToHGlobalUni(text);
        try {
            Send(input, 0x00B1, IntPtr.Zero, new IntPtr(-1));
            Send(input, 0x00C2, new IntPtr(1), data);
        } finally { Marshal.FreeHGlobal(data); }
    }
    IntPtr Parent(IntPtr h, uint m, IntPtr w, IntPtr l)
    {
        if (m == 0x0111 && ((w.ToInt64() >> 16) & 0xFFFF) == 0x0300 && l == input) Interlocked.Increment(ref Changes);
        if (m == 0x0010) { DestroyWindow(h); return IntPtr.Zero; }
        if (m == 0x0002) { PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProcW(h, m, w, l);
    }
    IntPtr Input(IntPtr h, uint m, IntPtr w, IntPtr l)
    {
        if (m == 0x0100 && w.ToInt32() == 13) {
            Interlocked.Increment(ref EnterRequests);
            if (accept && Changes > 0) { Submitted = Read(); Interlocked.Increment(ref Submissions); Write(""); }
            return IntPtr.Zero;
        }
        return CallWindowProcW(original, h, m, w, l);
    }
    void Run()
    {
        try {
            if (LoadLibraryW("Msftedit.dll") == IntPtr.Zero) throw new Exception("RichEdit library unavailable.");
            parentProcedure = Parent; inputProcedure = Input;
            var cls = new WindowClass {name = Title, instance = GetModuleHandleW(IntPtr.Zero), procedure = parentProcedure};
            if (RegisterClassW(ref cls) == 0) throw new Exception("Fixture class registration failed.");
            // Hidden, initially minimized, no activation. No user application is altered.
            parent = CreateWindowExW(0x08000080, Title, Title, 0xA0000000, 0, 0, 400, 300, IntPtr.Zero, IntPtr.Zero, cls.instance, IntPtr.Zero);
            input = CreateWindowExW(0, "RICHEDIT50W", "", 0x40000004, 0, 0, 300, 100, parent, new IntPtr(1006), cls.instance, IntPtr.Zero);
            if (parent == IntPtr.Zero || input == IntPtr.Zero) throw new Exception("Fixture window creation failed.");
            original = SetWindowLong(input, -4, Marshal.GetFunctionPointerForDelegate(inputProcedure));
            Send(input, 0x0445, IntPtr.Zero, new IntPtr(1)); // EM_SETEVENTMASK / ENM_CHANGE.
            Write(initial); Send(input, 0x00CD, IntPtr.Zero, IntPtr.Zero); // Empty undo buffer.
            Changes = 0; ready.Set();
            Message message;
            while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) DispatchMessageW(ref message);
        } catch (Exception error) { startupError = error; ready.Set(); }
    }
    public void Dispose() { if (parent != IntPtr.Zero) PostMessageW(parent, 0x0010, IntPtr.Zero, IntPtr.Zero); if (!thread.Join(5000)) throw new Exception("Fixture did not stop."); ready.Dispose(); }
    static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    public static double[] MeasureSubmissions()
    {
        var samples = new double[5];
        int pid = Process.GetCurrentProcess().Id;
        using (var fixture = new ChatWindowFixture(true, "")) {
            IntPtr before = Foreground;
            for (int i = 0; i < samples.Length; i++) {
                var watch = Stopwatch.StartNew();
                Assert(ClientChatWindow.Submit(pid, fixture.Title, "Synthetic latency sample"), "Submission failed.");
                samples[i] = Math.Round(watch.Elapsed.TotalMilliseconds, 2);
            }
            Assert(fixture.EnterRequests == samples.Length && fixture.Submissions == samples.Length, "Duplicate or missing submission.");
            Assert(fixture.Minimized && !fixture.Visible && Foreground == before, "Latency test changed foreground or visibility.");
        }
        return samples;
    }
    public static int Validate()
    {
        int pid = Process.GetCurrentProcess().Id;
        const string text = "Local test: \uD55C\uAE00 \uD83D\uDC4B\nsecond line";
        string[] hints = { "메시지 입력", "답장 메시지 입력", "댓글 메시지 입력" };
        foreach (string hint in hints) using (var fixture = new ChatWindowFixture(true, hint)) {
            IntPtr before = Foreground;
            Assert(fixture.Minimized && !fixture.Visible, "Fixture must start hidden and minimized.");
            Assert(ClientChatWindow.Submit(pid, fixture.Title, text), "Submission failed.");
            Assert(fixture.Changes > 0, "Parent did not receive EN_CHANGE.");
            Assert(fixture.Submitted.Replace("\r\n", "\n").Replace("\r", "\n") == text, "Unicode or multiline text differs.");
            Assert(fixture.EnterRequests == 1 && fixture.Submissions == 1, "Submission must occur once.");
            Assert(fixture.Minimized && !fixture.Visible && Foreground == before, "Window visibility or foreground changed.");
        }
        using (var fixture = new ChatWindowFixture(false, "")) {
            var watch = Stopwatch.StartNew();
            try { ClientChatWindow.Submit(pid, fixture.Title, "keep this draft"); throw new Exception("Unconfirmed submission accepted."); }
            catch (ClientSubmitException error) { Assert(error.Code == "SUBMISSION_UNCONFIRMED", "Unexpected error."); }
            Assert(watch.ElapsedMilliseconds >= 2000, "Confirmation deadline was shortened.");
            Assert(fixture.Read() == "keep this draft" && fixture.EnterRequests == 1 && fixture.Submissions == 0, "Unconfirmed draft changed or was retried.");
            Assert(fixture.Minimized && !fixture.Visible, "Failed submission restored the window.");
        }
        using (var fixture = new ChatWindowFixture(true, "existing draft")) {
            try { ClientChatWindow.Submit(pid, fixture.Title, "replacement"); throw new Exception("Existing draft accepted."); }
            catch (ClientSubmitException error) { Assert(error.Code == "DRAFT_EXISTS", "Unexpected draft error."); }
            Assert(fixture.Read() == "existing draft" && fixture.EnterRequests == 0 && fixture.Changes == 0, "Existing draft was altered.");
        }
        foreach (string hint in hints) using (var fixture = new ChatWindowFixture(true, "")) {
            fixture.Type(hint);
            int changes = fixture.Changes;
            try { ClientChatWindow.Submit(pid, fixture.Title, "replacement"); throw new Exception("Typed hint accepted as empty."); }
            catch (ClientSubmitException error) { Assert(error.Code == "DRAFT_EXISTS", "Unexpected typed-hint error."); }
            Assert(fixture.Read() == hint && fixture.EnterRequests == 0 && fixture.Changes == changes, "User-typed hint was altered.");
        }
        return 8;
    }
}
