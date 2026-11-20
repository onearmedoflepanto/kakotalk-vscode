using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace LocalChatResearch
{
    public sealed class HistoryWindowInfo
    {
        public string Handle, Parent, ClassName;
        public int ControlId, Minimum, Maximum, Position;
        public uint Page;
        public bool ScrollInfo, Minimized;
    }

    public static class ClientHistoryWindow
    {
        delegate bool EnumWindow(IntPtr handle, IntPtr parameter);
        [StructLayout(LayoutKind.Sequential)] struct ScrollInfo { public uint Size, Mask; public int Min, Max; public uint Page; public int Pos, TrackPos; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder value, int maximum);
        [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] static extern bool GetScrollInfo(IntPtr handle, int bar, ref ScrollInfo info);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
        [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr handle, out Rect rect);
        [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)]
        static extern IntPtr SendTimeout(IntPtr handle, uint message, UIntPtr parameter, IntPtr data, uint flags, uint timeout, out UIntPtr result);
        static string ClassName(IntPtr handle) { var text = new StringBuilder(128); GetClassName(handle, text, text.Capacity); return text.ToString(); }
        static uint Owner(IntPtr handle) { uint pid; GetWindowThreadProcessId(handle, out pid); return pid; }
        public static string Foreground() { return "0x" + GetForegroundWindow().ToInt64().ToString("X"); }
        public static bool Minimized(ulong window) { return IsIconic(new IntPtr((long)window)); }
        public static void ScrollOlder(int pid, ulong window)
        {
            var parent = new IntPtr((long)window); var lists = new List<IntPtr>();
            if (Owner(parent) != (uint)pid) throw new InvalidOperationException("History window changed.");
            EnumChildWindows(parent, (handle, unused) => {
                if (GetParent(handle) == parent && GetDlgCtrlID(handle) == 100 && ClassName(handle) == "EVA_VH_ListControl_Dblclk") lists.Add(handle);
                return true;
            }, IntPtr.Zero);
            if (lists.Count != 1) throw new InvalidOperationException("Chat history control is not loaded.");
            IntPtr list = lists[0];
            if (Owner(list) != (uint)pid || !IsChild(parent, list) || !IsWindowEnabled(list)) throw new InvalidOperationException("History window changed.");
            // The existing client handles loading. No activation, keyboard input or protocol calls.
            IntPtr bar = IntPtr.Zero;
            EnumChildWindows(list, (handle, unused) => { if (GetParent(handle) == list && GetDlgCtrlID(handle) == 202 && ClassName(handle) == "_EVA_CustomScrollCtrl") bar = handle; return true; }, IntPtr.Zero);
            if (bar == IntPtr.Zero || Owner(bar) != (uint)pid || !IsChild(list, bar) || !IsWindowEnabled(bar)) throw new InvalidOperationException("Chat history scrollbar is not loaded.");
            UIntPtr result;
            Rect bounds;
            if (!GetClientRect(bar, out bounds) || bounds.Right <= 0 || bounds.Bottom <= 0) throw new InvalidOperationException("Chat history scrollbar has no layout.");
            var point = new IntPtr((Math.Min(2, bounds.Bottom - 1) << 16) | (bounds.Right / 2));
            bool pressed = SendTimeout(bar, 0x0201, new UIntPtr(1), point, 0x23, 1500, out result) != IntPtr.Zero;
            bool released = SendTimeout(bar, 0x0202, UIntPtr.Zero, point, 0x23, 1500, out result) != IntPtr.Zero;
            if (!pressed || !released)
                throw new InvalidOperationException("Chat history control did not respond.");
        }
        public static HistoryWindowInfo[] Inspect(ulong window)
        {
            var result = new List<HistoryWindowInfo>(); var parent = new IntPtr((long)window);
            EnumChildWindows(parent, (handle, unused) => {
                var scroll = new ScrollInfo { Size = (uint)Marshal.SizeOf(typeof(ScrollInfo)), Mask = 0x17 };
                bool found = GetScrollInfo(handle, 1, ref scroll);
                result.Add(new HistoryWindowInfo { Handle = "0x" + handle.ToInt64().ToString("X"), Parent = "0x" + GetParent(handle).ToInt64().ToString("X"),
                    ClassName = ClassName(handle), ControlId = GetDlgCtrlID(handle), ScrollInfo = found, Minimum = scroll.Min, Maximum = scroll.Max,
                    Page = scroll.Page, Position = scroll.Pos, Minimized = IsIconic(parent) });
                return true;
            }, IntPtr.Zero);
            return result.ToArray();
        }
    }
}
