using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LocalChatResearch
{
    public sealed class ClientSubmitException : InvalidOperationException
    {
        public string Code { get; private set; }
        public ClientSubmitException(string code) : base(code) { Code = code; }
    }

    public sealed class ChatInputDiagnostic
    {
        public string WindowTitle, WindowHandle, InputClass, InputHandle, ForegroundHandle;
        public int ControlId, CopiedLength;
        public ulong ReportedLength, LineCount, FirstLineLength;
        public bool WhitespaceOnly, MatchesInputHint, Modified, CanUndo, EmptyDraft, Minimized;
    }

    // Invoked only after a user explicitly presses Send in the extension.
    public static class ClientChatWindow
    {
        const string InputHint = "메시지 입력";
        const string ReplyInputHint = "답장 메시지 입력";
        const string CommentInputHint = "댓글 메시지 입력";
        delegate bool EnumWindow(IntPtr handle, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder value, int maximum);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder value, int maximum);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
        [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
        static extern IntPtr SendTimeout(IntPtr handle, uint message, UIntPtr parameter, IntPtr data, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
        static extern bool Post(IntPtr handle, uint message, IntPtr parameter, IntPtr data);

        static string Title(IntPtr handle) { var text = new StringBuilder(512); GetWindowText(handle, text, text.Capacity); return text.ToString(); }
        static string ClassName(IntPtr handle) { var text = new StringBuilder(128); GetClassName(handle, text, text.Capacity); return text.ToString(); }
        static uint Owner(IntPtr handle) { uint pid; GetWindowThreadProcessId(handle, out pid); return pid; }
        static ulong Send(IntPtr handle, uint message, ulong parameter, IntPtr data)
        {
            UIntPtr result;
            if (SendTimeout(handle, message, new UIntPtr(parameter), data, 0x23, 1500, out result) == IntPtr.Zero)
                throw new ClientSubmitException("INPUT_UNRESPONSIVE");
            return result.ToUInt64();
        }
        static string ReadInput(IntPtr input, int maximum)
        {
            IntPtr data = Marshal.AllocHGlobal((maximum + 1) * 2);
            try {
                Marshal.WriteInt16(data, 0);
                ulong copied = Send(input, 0x000D, (ulong)(maximum + 1), data);
                if (copied > (ulong)maximum) throw new ClientSubmitException("INPUT_UNRESPONSIVE");
                return Marshal.PtrToStringUni(data, (int)copied) ?? "";
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        // This client stores its empty-input hint as actual RichEdit text, with no undo entry.
        // A user-typed identical string has undo history and remains a protected draft.
        static bool IsInputHint(string text)
        {
            return text == InputHint || text == ReplyInputHint || text == CommentInputHint;
        }
        public static bool IsEmptyDraft(string text, bool canUndo)
        {
            return text == "" || (IsInputHint(text) && !canUndo);
        }
        static bool IsEmptyInput(IntPtr input)
        {
            return IsEmptyDraft(ReadInput(input, 2001), Send(input, 0x00C6, 0, IntPtr.Zero) != 0);
        }
        public static bool IsSubmissionCleared(string submitted, string current, bool canUndo)
        {
            // An identical hint-shaped message cannot prove submission; leave it unconfirmed.
            return current == "" || (!IsInputHint(submitted) && IsEmptyDraft(current, canUndo));
        }
        // Read-only diagnostics never return draft text or alter focus/input.
        public static ChatInputDiagnostic[] InspectInputs(int pid)
        {
            var result = new List<ChatInputDiagnostic>();
            EnumWindows((window, parameter) => {
                if (Owner(window) != (uint)pid) return true;
                EnumChildWindows(window, (input, data) => {
                    if (GetDlgCtrlID(input) != 1006 || !ClassName(input).StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) return true;
                    ulong length = Send(input, 0x000E, 0, IntPtr.Zero);
                    string text = ReadInput(input, 2001);
                    bool canUndo = Send(input, 0x00C6, 0, IntPtr.Zero) != 0;
                    result.Add(new ChatInputDiagnostic {WindowTitle = Title(window), WindowHandle = window.ToString("X"), InputClass = ClassName(input), InputHandle = input.ToString("X"),
                        ControlId = GetDlgCtrlID(input), ReportedLength = length, CopiedLength = text.Length, WhitespaceOnly = String.IsNullOrWhiteSpace(text),
                        MatchesInputHint = IsInputHint(text), LineCount = Send(input, 0x00BA, 0, IntPtr.Zero), FirstLineLength = Send(input, 0x00C1, 0, IntPtr.Zero),
                        Modified = Send(input, 0x00B8, 0, IntPtr.Zero) != 0, CanUndo = canUndo, EmptyDraft = IsEmptyDraft(text, canUndo),
                        Minimized = IsIconic(window), ForegroundHandle = GetForegroundWindow().ToString("X")});
                    return true;
                }, IntPtr.Zero);
                return true;
            }, IntPtr.Zero);
            return result.ToArray();
        }
        static string Normalize(string value) { return value.Replace("\r\n", "\n").Replace("\r", "\n"); }
        static void CheckIdentity(IntPtr window, IntPtr input, int pid, string title)
        {
            if (Owner(window) != (uint)pid || Owner(input) != (uint)pid || Title(window) != title || !IsChild(window, input) || !IsWindowEnabled(input))
                throw new ClientSubmitException("ROOM_CHANGED");
        }

        public static bool Submit(int pid, string title, string text)
        { return Submit(pid, title, text, null, 0, 0); }
        public static bool Submit(int pid, string title, string text, Action validateContext, ulong expectedWindow, ulong expectedEditor)
        {
            if (String.IsNullOrWhiteSpace(text) || text.Length > 2000 || text.IndexOf('\0') >= 0) throw new ClientSubmitException("INVALID_TEXT");
            var windows = new List<IntPtr>();
            EnumWindows((window, data) => { if (Owner(window) == (uint)pid && Title(window) == title) windows.Add(window); return true; }, IntPtr.Zero);
            if (windows.Count != 1) throw new ClientSubmitException("WINDOW_UNAVAILABLE");
            IntPtr target = windows[0]; var inputs = new List<IntPtr>();
            EnumChildWindows(target, (input, data) => {
                if (GetDlgCtrlID(input) == 1006 && ClassName(input).StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) inputs.Add(input);
                return true;
            }, IntPtr.Zero);
            if (inputs.Count != 1) throw new ClientSubmitException("INPUT_UNAVAILABLE");
            IntPtr editor = inputs[0];
            if ((expectedWindow != 0 && (ulong)target.ToInt64() != expectedWindow) || (expectedEditor != 0 && (ulong)editor.ToInt64() != expectedEditor)) throw new ClientSubmitException("ROOM_CHANGED");
            CheckIdentity(target, editor, pid, title);
            if (validateContext != null) validateContext();
            if (!IsEmptyInput(editor)) throw new ClientSubmitException("DRAFT_EXISTS");
            foreach (int key in new int[] { 0x10, 0x11, 0x12 }) if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new ClientSubmitException("MODIFIER_HELD");
            // Replace through RichEdit's editing path so the parent receives input-change
            // notifications. Do not restore, activate, focus, or attach input threads.
            Send(editor, 0x00B1, 0, new IntPtr(-1)); // EM_SETSEL: select the empty-input hint.
            CheckIdentity(target, editor, pid, title);
            if (!IsEmptyInput(editor)) throw new ClientSubmitException("DRAFT_EXISTS");
            IntPtr value = Marshal.StringToHGlobalUni(text);
            try { Send(editor, 0x00C2, 1, value); } // EM_REPLACESEL: preserve undo history.
            finally { Marshal.FreeHGlobal(value); }
            if (Normalize(ReadInput(editor, 2001)) != Normalize(text)) throw new ClientSubmitException("TEXT_MISMATCH");
            CheckIdentity(target, editor, pid, title);
            if (validateContext != null) validateContext();
            if (!Post(editor, 0x0100, new IntPtr(13), new IntPtr(0x001C0001))) throw new ClientSubmitException("SUBMISSION_UNCONFIRMED");
            Post(editor, 0x0101, new IntPtr(13), new IntPtr(unchecked((int)0xC01C0001)));
            var confirmation = Stopwatch.StartNew();
            while (true) {
                CheckIdentity(target, editor, pid, title);
                if (IsSubmissionCleared(text, ReadInput(editor, 2001), Send(editor, 0x00C6, 0, IntPtr.Zero) != 0)) return true;
                if (confirmation.ElapsedMilliseconds >= 2000) break;
                Thread.Sleep(20);
            }
            throw new ClientSubmitException("SUBMISSION_UNCONFIRMED");
        }
    }
}
