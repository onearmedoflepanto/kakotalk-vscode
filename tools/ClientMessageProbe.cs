using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace LocalChatResearch
{
    // Local observation. The target handle never has write, debug,
    // thread-control or network permissions. No target code is executed.
    public sealed class ClientMessageProbe : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MemoryInfo
        {
            public IntPtr BaseAddress, AllocationBase;
            public uint AllocationProtect;
            public ushort PartitionId;
            public UIntPtr RegionSize;
            public uint State, Protect, Type;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryInfo info, UIntPtr length);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")]
        static extern bool IsChild(IntPtr parent, IntPtr child);

        public const string ExpectedHash = "bfb4206321786d0f5c8a9e0ff2a1959e0e901a18bcea40a652b49229b8b86bf1";
        public const string OctoberHash = "74b5cb59eef61a9c011d6f731619982753c1b20b0848cf121a90e46c7fe2a820";
        public readonly string FileSha256;
        public readonly string ClientVersion;
        public readonly uint SetterRva;
        readonly Dictionary<string, ulong> buildTables;
        static readonly string[] buildClasses = { "ChatLogContent_Msg", "ChatLogContent_TextMsg", "ChatLogContent_EmoticonText",
            "TalkChatRoom", "TalkChatRoomInfo_Mutable", "TalkUser_Mutable", "TalkUser", "ChatLogContent_Reply",
            "ChatLogContent_BalloonFactory", "ChatLogContent_Photo", "CChatDlg", "ChatRoom_ViewModel", "ChatDelegate_Input" };
        public static ulong[] BuildTableRvas(string hash)
        {
            if (hash == ExpectedHash) return new ulong[] { 0x2949870, 0x27fd660, 0x2915158, 0x29c2ac8, 0x2a14788,
                0x280f948, 0x280f918, 0x2946210, 0x2946438, 0x294a150, 0x2943a70, 0x2907f30, 0x27f3c00 };
            if (hash == OctoberHash) return new ulong[] { 0x2964258, 0x2817248, 0x292fb70, 0x29ddd50, 0x2a320d8,
                0x2829a98, 0x2829a68, 0x29606e8, 0x2960920, 0x2964ad8, 0x295f0a8, 0x2922bf0, 0x280d1e0 };
            throw new InvalidOperationException("Unsupported client build.");
        }
        ulong Table(string name) { return buildTables[".?AV" + name + "@@"]; }
        ulong[] Tables(string[] names) { return Array.ConvertAll(names, name => buildTables[name]); }
        IntPtr handle;
        public readonly ulong ImageBase;
        public readonly int ImageSize;
        public readonly int ProcessId;
        public readonly long ProcessStartFileTime;
        readonly Dictionary<ulong, InputTarget> inputTargets = new Dictionary<ulong, InputTarget>();
        public int InputDiscoveryCount { get; private set; }
        public int InputCacheHitCount { get; private set; }
        public long ScannedBytes;
        public int ReadFailures;
        public bool ScanLimitReached;
        public sealed class Region { public ulong Address, Size; }
        public sealed class Field { public string Offset, Hex, Unsigned, PointeeType; }
        public sealed class TextHit { public string Address, Encoding; }
        public sealed class Reference { public string Address, Target; }
        public sealed class ObjectHit { public string Address, Class; }
        public sealed class SearchResult
        {
            public List<TextHit> Text = new List<TextHit>();
            public List<ObjectHit> Objects = new List<ObjectHit>();
            public long ScannedBytes;
            public int ReadFailures;
            public bool ScanLimitReached;
            public bool TextLimitReached, ObjectLimitReached;
        }
        public sealed class StringValue
        {
            public string Pointer, Encoding, Text, Sha256;
            public long Length;
            public bool Stable;
        }
        public sealed class ValidationRecord
        {
            public string BodySha256, SenderName, SenderId, RoomName, RoomId, MessageId;
            public int BodyCharacters;
            public string UiObject, UiClass, RoomObject, RoomInfoObject, ChatDbObject, InputObject, SenderObject;
            public string InputBodyPointer, UiBodyPointer, OverrideRva, BaseSetterRva;
            public bool BodyExactMatch, SenderExactMatch, RoomExactMatch, Stable, CallPathVerified;
            public bool FunctionEntryObserved;
        }
        public sealed class ValidationResult
        {
            public string Status;
            public List<ValidationRecord> Messages = new List<ValidationRecord>();
            public long ScannedBytes;
            public int ReadFailures;
            public bool ScanLimitReached, ObjectLimitReached;
            public string Method = "Read-only object snapshots and local cross-object comparison; no function interception.";
        }
        public sealed class ProfileAddress { public string Id, Address; }
        public sealed class RoomChoice { public string Id, Title; }
        public sealed class ImagePreview { public string Mime, Data; }
        // The client retains the encoded thumbnail in its display image's HGLOBAL.
        // Read it without invoking a decoder, cache loader or download in the client.
        public ImagePreview ReadImagePreview(string selectedRoomId, string selectedMessageId, string selectedSenderId)
        {
            ulong roomId = UInt64.Parse(selectedRoomId), messageId = UInt64.Parse(selectedMessageId), senderId = UInt64.Parse(selectedSenderId);
            if (roomId == 0 || messageId == 0 || senderId == 0) throw new ArgumentException("Invalid image identity.");
            SearchResult search = FindObjects(new ulong[] { Table("ChatLogContent_Photo") }, new string[] { ".?AVChatLogContent_Photo@@" });
            if (search.ScanLimitReached || search.ObjectLimitReached) throw new InvalidOperationException("Image discovery limit reached.");
            ulong photo = 0;
            foreach (ObjectHit hit in search.Objects) {
                ulong at = Address(hit.Address);
                if (TypeName(at) != ".?AVChatLogContent_Photo@@" || Value(at + 0x60) != roomId || Value(at + 0x68) != messageId) continue;
                if (photo != 0) throw new InvalidOperationException("Ambiguous image model.");
                photo = at;
            }
            if (photo == 0) throw new InvalidOperationException("Image is not loaded.");
            ulong image = Value(photo + 0x378), container = Value(photo + 0x380), memory = Value(image + 0x30);
            ulong handle = Value(memory + 0x10), length = Value(memory + 0x18), data = Value(handle);
            Func<bool> valid = () => TypeName(photo) == ".?AVChatLogContent_Photo@@" && Value(photo + 0x60) == roomId && Value(photo + 0x68) == messageId
                && Value(photo + 0x378) == image && Value(photo + 0x380) == container && TypeName(container) == ".?AVChatLogThumbnailImageContainer@@"
                && Value(container + 0x30) == image && Value(container + 0x60) == roomId && Value(container + 0x68) == messageId && Value(container + 0x70) == senderId
                && TypeName(image) == ".?AVGdipImage@xp@@" && Value(image + 0x30) == memory && TypeName(memory) == ".?AVWin32GlobalMemory@eva@@"
                && Value(memory + 8) == 1 && Value(memory + 0x10) == handle && Value(memory + 0x18) == length && Value(handle) == data;
            if (length < 24 || length > 1024 * 1024 || !valid()) throw new InvalidOperationException("Image buffer is unavailable.");
            byte[] first = Read(data, (int)length), second = Read(data, (int)length);
            if (first == null || second == null || !valid()) throw new InvalidOperationException("Image changed while reading.");
            for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) throw new InvalidOperationException("Image bytes changed while reading.");
            string mime;
            if (first[0] == 255 && first[1] == 216 && first[2] == 255) mime = "image/jpeg";
            else if (first[0] == 137 && first[1] == 80 && first[2] == 78 && first[3] == 71 && first[4] == 13 && first[5] == 10 && first[6] == 26 && first[7] == 10) mime = "image/png";
            else throw new InvalidOperationException("Unsupported thumbnail format.");
            return new ImagePreview { Mime = mime, Data = Convert.ToBase64String(first) };
        }
        public sealed class InputTarget { public ulong Dialog, Model, Input, RoomId, Window, Editor; public string Title; }
        bool OwnsWindow(ulong window)
        {
            uint pid;
            return window != 0 && GetWindowThreadProcessId(new IntPtr((long)window), out pid) != 0 && pid == (uint)ProcessId;
        }
        InputTarget ReadInputTarget(ulong dialog, ulong roomId, string title)
        {
            ulong model = Value(dialog + 0x640), room = Value(model + 0xe8), info = Value(room + 0x188), input = Value(dialog + 0xbe8);
            if (TypeName(dialog) != ".?AVCChatDlg@@" || TypeName(model) != ".?AVChatRoom_ViewModel@@" || TypeName(room) != ".?AVTalkChatRoom@@"
                || TypeName(info) != ".?AVTalkChatRoomInfo_Mutable@@" || Value(info + 0x18) != roomId || TypeName(input) != ".?AVChatDelegate_Input@@") return null;
            StringValue name = ReadString(Value(info + 0x40), true);
            ulong window = Value(dialog + 0x40), editor = Value(Value(input + 0x48) + 0x40);
            if (name == null || !name.Stable || name.Text != title || Value(input + 0x38) != model || Value(input + 0x28) != dialog
                || !OwnsWindow(window) || !OwnsWindow(editor) || !IsChild(new IntPtr((long)window), new IntPtr((long)editor))) return null;
            if (Value(dialog + 0x640) != model || Value(model + 0xe8) != room || Value(room + 0x188) != info || Value(dialog + 0xbe8) != input
                || Value(info + 0x18) != roomId || Value(dialog + 0x40) != window || Value(Value(input + 0x48) + 0x40) != editor) return null;
            return new InputTarget { Dialog = dialog, Model = model, Input = input, RoomId = roomId, Window = window, Editor = editor, Title = title };
        }
        public bool IsInputTargetCurrent(InputTarget target)
        {
            if (target == null || handle == IntPtr.Zero) return false;
            InputTarget current = ReadInputTarget(target.Dialog, target.RoomId, target.Title);
            return current != null && current.Model == target.Model && current.Input == target.Input && current.Window == target.Window && current.Editor == target.Editor;
        }
        public void ClearInputTargets() { inputTargets.Clear(); }
        public InputTarget FindInputTarget(string selectedRoomId, string title)
        {
            ulong roomId = UInt64.Parse(selectedRoomId);
            InputTarget cached;
            if (inputTargets.TryGetValue(roomId, out cached)) {
                if (cached.Title == title && IsInputTargetCurrent(cached)) { InputCacheHitCount++; return cached; }
                inputTargets.Remove(roomId);
            }
            InputDiscoveryCount++;
            SearchResult found = FindObjects(new ulong[] { Table("CChatDlg") }, new string[] { ".?AVCChatDlg@@" });
            if (found.ScanLimitReached || found.ObjectLimitReached) throw new InvalidOperationException("Input discovery limit reached.");
            InputTarget result = null;
            foreach (ObjectHit item in found.Objects) {
                InputTarget candidate = ReadInputTarget(Address(item.Address), roomId, title);
                if (candidate == null) continue;
                if (result != null) throw new InvalidOperationException("Ambiguous input model.");
                result = candidate;
            }
            if (result == null) throw new InvalidOperationException("Selected room input is not loaded.");
            if (inputTargets.Count >= 16) inputTargets.Clear();
            inputTargets[roomId] = result;
            return result;
        }
        public string CheckInputContext(InputTarget target, string replyId, string senderId)
        {
            if (!IsInputTargetCurrent(target)) return "ROOM_CHANGED";
            ulong input = target.Input;
            byte[] modeBytes = Read(input + 0x88, 4), present = Read(input + 0x450, 1);
            if (modeBytes == null || present == null) return "REPLY_MISMATCH";
            uint mode = BitConverter.ToUInt32(modeBytes, 0);
            if (String.IsNullOrEmpty(replyId)) return mode == 0 ? "" : "REPLY_CONFLICT";
            return mode == 1 && present[0] == 1 && Value(input + 0x288).ToString() == replyId && Value(input + 0x290) == target.RoomId
                && Value(input + 0x2a0).ToString() == senderId ? "" : "REPLY_MISMATCH";
        }
        public sealed class RoomState
        {
            public string Id, Title, LastMessageId, LastMessageAt, LastSenderId;
            public uint UnreadCount;
        }
        List<ulong> stateRooms = new List<ulong>();
        DateTime stateScanAt = DateTime.MinValue;
        public sealed class CollectorMetadata
        {
            public string RoomId, RoomTitle, RoomObject;
            public List<ProfileAddress> Profiles = new List<ProfileAddress>();
            public List<string> BaselineMessageIds = new List<string>();
            public List<string> InitialLogs = new List<string>();
            public int HistoryCandidateCount;
            public string OldestHistoryId;
            public long ScannedBytes;
            public int ReadFailures;
        }
        public static string Hex(ulong value) { return "0x" + value.ToString("X"); }

        public ClientMessageProbe(int pid, string expectedPath)
        {
            if (IntPtr.Size != 8) throw new InvalidOperationException("64-bit host required.");
            handle = OpenProcess(0x0410, false, pid);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
            using (Process p = Process.GetProcessById(pid))
            {
                ProcessModule m = p.MainModule;
                if (!String.Equals(Path.GetFullPath(expectedPath), Path.GetFullPath(m.FileName), StringComparison.OrdinalIgnoreCase)
                    || !String.Equals(Path.GetFileName(m.FileName), "KakaoTalk.exe", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Unexpected target path.");
                using (var stream = File.OpenRead(m.FileName))
                using (var sha = SHA256.Create())
                    FileSha256 = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                ClientVersion = FileVersionInfo.GetVersionInfo(m.FileName).FileVersion;
                if (FileSha256 != ExpectedHash && FileSha256 != OctoberHash)
                    throw new InvalidOperationException("지원하지 않는 PC카톡 빌드입니다. 현재 버전: " + ClientVersion
                        + ". 지원 버전: 26.9.2.5342, 26.10.0.5364. 확장 업데이트가 필요합니다.");
                SetterRva = FileSha256 == ExpectedHash ? 0x13fb9d0U : 0x1405c00U;
                buildTables = new Dictionary<string, ulong>();
                ulong[] tableRvas = BuildTableRvas(FileSha256);
                for (int i = 0; i < buildClasses.Length; i++) buildTables[".?AV" + buildClasses[i] + "@@"] = tableRvas[i];
                ImageBase = (ulong)m.BaseAddress.ToInt64();
                ImageSize = m.ModuleMemorySize;
                foreach (var table in buildTables)
                    if (TableTypeName(ImageBase + table.Value) != table.Key)
                        throw new InvalidOperationException("PC카톡 클래스 구조가 지원 빌드와 일치하지 않습니다.");
                long created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user) || p.HasExited || created != p.StartTime.ToUniversalTime().ToFileTimeUtc())
                    throw new InvalidOperationException("Client process changed during initialization.");
                ProcessId = pid; ProcessStartFileTime = created;
            }
            } catch { Dispose(); throw; }
        }
        public bool IsCurrentProcess(int pid)
        {
            if (handle == IntPtr.Zero || pid != ProcessId) return false;
            try { using (Process p = Process.GetProcessById(pid)) { return !p.HasExited && p.StartTime.ToUniversalTime().ToFileTimeUtc() == ProcessStartFileTime; } }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch (Win32Exception) { return false; }
        }
        public void Dispose() { inputTargets.Clear(); if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
        static bool Readable(uint protection)
        {
            uint basic = protection & 0xff;
            return (protection & 0x100) == 0 && (basic == 2 || basic == 4 || basic == 8 || basic == 0x20 || basic == 0x40 || basic == 0x80);
        }
        public byte[] Read(ulong address, int length)
        {
            if (address < 0x10000 || length < 1 || length > 1024 * 1024 || address > 0x7FFFFFFFFFFFUL - (ulong)length) return null;
            MemoryInfo info;
            if (VirtualQueryEx(handle, new IntPtr((long)address), out info, new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryInfo)))) == UIntPtr.Zero
                || info.State != 0x1000 || !Readable(info.Protect)
                || address + (ulong)length > (ulong)info.BaseAddress.ToInt64() + info.RegionSize.ToUInt64()) return null;
            byte[] bytes = new byte[length];
            UIntPtr read;
            if (!ReadProcessMemory(handle, new IntPtr((long)address), bytes, new UIntPtr((uint)length), out read) || read.ToUInt64() != (ulong)length)
            { ReadFailures++; return null; }
            return bytes;
        }
        public List<Region> PrivateRegions()
        {
            var result = new List<Region>();
            ulong at = 0x10000;
            while (at < 0x7FFFFFFFFFFFUL)
            {
                MemoryInfo info;
                if (VirtualQueryEx(handle, new IntPtr((long)at), out info, new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryInfo)))) == UIntPtr.Zero) break;
                ulong start = (ulong)info.BaseAddress.ToInt64();
                ulong length = info.RegionSize.ToUInt64();
                if (length == 0 || start + length <= at) break;
                uint basic = info.Protect & 0xff;
                if (info.State == 0x1000 && info.Type == 0x20000 && Readable(info.Protect) && (basic == 4 || basic == 8))
                    result.Add(new Region { Address = start, Size = length });
                at = start + length;
            }
            return result;
        }
        void Scan(Action<ulong, byte[], int> visitor, int overlap)
        {
            ScannedBytes = 0; ScanLimitReached = false;
            Stopwatch timer = Stopwatch.StartNew();
            foreach (Region region in PrivateRegions())
            {
                for (ulong at = region.Address; at < region.Address + region.Size; )
                {
                    if (ScannedBytes >= 1024L * 1024 * 1024 || timer.Elapsed.TotalSeconds > 45) { ScanLimitReached = true; return; }
                    int count = (int)Math.Min(1024UL * 1024, region.Address + region.Size - at);
                    byte[] bytes = Read(at, count);
                    if (bytes != null) { visitor(at, bytes, count); ScannedBytes += count; Array.Clear(bytes, 0, bytes.Length); }
                    at += (ulong)(count > overlap ? count - overlap : count);
                }
            }
        }
        public SearchResult Find(string needle, ulong[] vtables, string[] names)
        {
            if (String.IsNullOrEmpty(needle) || needle.Length < 3 || needle.Length > 256 || vtables.Length != names.Length)
                throw new ArgumentException("Use a selected message or sender name (3..256 characters) and paired vtable names.");
            var result = new SearchResult();
            var tables = new Dictionary<ulong, string>();
            for (int i = 0; i < vtables.Length; i++) tables[ImageBase + vtables[i]] = names[i];
            byte[][] needles = { Encoding.UTF8.GetBytes(needle), Encoding.Unicode.GetBytes(needle) };
            var seenText = new HashSet<ulong>(); var seenObjects = new HashSet<ulong>();
            Scan((address, bytes, count) => {
                for (int encoding = 0; encoding < needles.Length; encoding++)
                {
                    byte[] pattern = needles[encoding];
                    for (int i = 0; i + pattern.Length <= count; i++)
                    {
                        if (bytes[i] != pattern[0]) continue;
                        int j = 1; while (j < pattern.Length && bytes[i + j] == pattern[j]) j++;
                        if (j == pattern.Length && seenText.Add(address + (ulong)i)) {
                            if (result.Text.Count < 256) result.Text.Add(new TextHit { Address = Hex(address + (ulong)i), Encoding = encoding == 0 ? "utf-8" : "utf-16le" });
                            else result.TextLimitReached = true;
                        }
                    }
                }
                int align = (int)((8 - address % 8) % 8);
                for (int i = align; i + 8 <= count; i += 8)
                {
                    string name;
                    if (tables.TryGetValue(BitConverter.ToUInt64(bytes, i), out name) && seenObjects.Add(address + (ulong)i)) {
                        if (result.Objects.Count < 4096) result.Objects.Add(new ObjectHit { Address = Hex(address + (ulong)i), Class = name });
                        else result.ObjectLimitReached = true;
                    }
                }
            }, 1024);
            result.ScannedBytes = ScannedBytes; result.ReadFailures = ReadFailures; result.ScanLimitReached = ScanLimitReached;
            return result;
        }
        public List<Reference> References(ulong[] targets)
        {
            if (targets.Length > 128) throw new ArgumentException("At most 128 selected targets.");
            var wanted = new HashSet<ulong>(targets);
            var result = new List<Reference>(); var seen = new HashSet<ulong>();
            Scan((address, bytes, count) => {
                int align = (int)((8 - address % 8) % 8);
                for (int i = align; i + 8 <= count && result.Count < 4096; i += 8)
                {
                    ulong value = BitConverter.ToUInt64(bytes, i);
                    if (wanted.Contains(value) && seen.Add(address + (ulong)i))
                        result.Add(new Reference { Address = Hex(address + (ulong)i), Target = Hex(value) });
                }
            }, 8);
            return result;
        }
        public SearchResult FindObjects(ulong[] vtables, string[] names)
        {
            if (vtables.Length != names.Length) throw new ArgumentException("Vtable/name count mismatch.");
            var result = new SearchResult(); var tables = new Dictionary<ulong, string>(); var seen = new HashSet<ulong>();
            for (int i = 0; i < vtables.Length; i++) tables[ImageBase + vtables[i]] = names[i];
            Scan((address, bytes, count) => {
                int align = (int)((8 - address % 8) % 8);
                for (int i = align; i + 8 <= count; i += 8)
                {
                    string name;
                    if (!tables.TryGetValue(BitConverter.ToUInt64(bytes, i), out name) || !seen.Add(address + (ulong)i)) continue;
                    if (result.Objects.Count >= 16384) { result.ObjectLimitReached = true; continue; }
                    result.Objects.Add(new ObjectHit { Address = Hex(address + (ulong)i), Class = name });
                }
            }, 8);
            result.ScannedBytes = ScannedBytes; result.ReadFailures = ReadFailures; result.ScanLimitReached = ScanLimitReached;
            return result;
        }
        public CollectorMetadata PrepareCollector(string selectedRoomId)
        { return PrepareCollector(selectedRoomId, ""); }
        public CollectorMetadata PrepareCollector(string selectedRoomId, string beforeMessageId)
        {
            ulong roomId;
            if (!UInt64.TryParse(selectedRoomId, out roomId) || roomId == 0) throw new ArgumentException("A numeric room ID is required.");
            string[] classes = { ".?AVChatLogContent_Msg@@", ".?AVChatLogContent_TextMsg@@", ".?AVChatLogContent_EmoticonText@@", ".?AVTalkChatRoom@@", ".?AVTalkUser_Mutable@@", ".?AVTalkUser@@", ".?AVChatLogContent_Reply@@", ".?AVChatLogContent_BalloonFactory@@", ".?AVChatLogContent_Photo@@" };
            SearchResult search = FindObjects(Tables(classes), classes);
            if (search.ScanLimitReached || search.ObjectLimitReached) throw new InvalidOperationException("Object discovery limit reached.");
            var result = new CollectorMetadata { RoomId = selectedRoomId, ScannedBytes = search.ScannedBytes };
            var seenMessages = new HashSet<string>(); var seenUsers = new HashSet<string>();
            ulong newestCachedId = 0;
            foreach (ObjectHit item in search.Objects)
            {
                ulong address = Address(item.Address);
                if (TypeName(address) != item.Class) continue;
                if (item.Class == ".?AVTalkChatRoom@@")
                {
                    ulong info = Value(address + 0x188);
                    if (TypeName(info) != ".?AVTalkChatRoomInfo_Mutable@@" || Value(info + 0x18) != roomId) continue;
                    StringValue title = ReadString(Value(info + 0x40), true);
                    if (title == null || !title.Stable || title.Text.Length > 256 || Value(address + 0x188) != info) continue;
                    result.RoomTitle = title.Text;
                    if (result.RoomObject == null) result.RoomObject = item.Address;
                    ulong cached = Value(address + 0xe8) + 0x20;
                    if (Value(cached + 8) == roomId)
                    {
                        ulong cachedId = Value(cached);
                        seenMessages.Add(cachedId.ToString());
                        if (cachedId > newestCachedId) { newestCachedId = cachedId; result.RoomObject = item.Address; }
                    }
                }
                else if (item.Class == ".?AVTalkUser_Mutable@@" || item.Class == ".?AVTalkUser@@")
                {
                    string id = Value(address + 0x20).ToString();
                    if (id != "0" && seenUsers.Add(id)) result.Profiles.Add(new ProfileAddress { Id = id, Address = item.Address });
                }
                else if (Value(address + 0x60) == roomId) seenMessages.Add(Value(address + 0x68).ToString());
            }
            if (result.RoomTitle == null) throw new InvalidOperationException("Selected room is not present in the local room model.");
            seenMessages.Remove("0"); result.BaselineMessageIds.AddRange(seenMessages);
            // Match resident log records by room, identity, type, timestamp and stable body.
            // A minimized room need not have rendered every resident message.
            ulong before = String.IsNullOrEmpty(beforeMessageId) ? UInt64.MaxValue : UInt64.Parse(beforeMessageId);
            var initialSeen = new HashSet<ulong>();
            var logs = new SortedDictionary<ulong, string>();
            double latestTime = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds + 86400;
            Scan((address, bytes, count) => {
                int align = 8 + (int)((8 - address % 8) % 8);
                for (int i = align; i + 48 <= count; i += 8) {
                    if (BitConverter.ToUInt64(bytes, i) != roomId) continue;
                    ulong at = address + (ulong)i - 8, id = BitConverter.ToUInt64(bytes, i - 8), sender = BitConverter.ToUInt64(bytes, i + 16);
                    if (id == 0 || id >= before || initialSeen.Contains(id) || sender == 0) continue;
                    uint kind = BitConverter.ToUInt32(bytes, i + 8), seconds = BitConverter.ToUInt32(bytes, i + 24);
                    if ((kind != 1 && kind != 2 && kind != 26 && kind != 72) || seconds < 946684800 || seconds > latestTime) continue;
                    StringValue body = kind == 2 ? null : ReadString(BitConverter.ToUInt64(bytes, i + 40), false);
                    if ((kind != 2 && (body == null || !body.Stable)) || Value(at) != id || Value(at + 8) != roomId || Value(at + 0x18) != sender) continue;
                    if (initialSeen.Count >= 65536) throw new InvalidOperationException("History record limit reached.");
                    initialSeen.Add(id); logs[id] = Hex(at);
                }
            }, 64);
            var orderedLogs = new List<string>(logs.Values);
            result.HistoryCandidateCount = logs.Count;
            foreach (ulong id in logs.Keys) { result.OldestHistoryId = id.ToString(); break; }
            if (orderedLogs.Count > 100) orderedLogs.RemoveRange(0, orderedLogs.Count - 100);
            result.InitialLogs.AddRange(orderedLogs);
            if (ScanLimitReached) throw new InvalidOperationException("Initial message discovery limit reached.");
            result.ReadFailures = ReadFailures;
            return result;
        }
        public List<RoomChoice> DiscoverRooms()
        {
            SearchResult search = FindObjects(new ulong[] { Table("TalkChatRoom") }, new string[] { ".?AVTalkChatRoom@@" });
            if (search.ScanLimitReached || search.ObjectLimitReached) throw new InvalidOperationException("Room discovery limit reached.");
            var result = new List<RoomChoice>(); var seen = new HashSet<ulong>();
            foreach (ObjectHit item in search.Objects)
            {
                ulong address = Address(item.Address), info = Value(address + 0x188);
                if (TypeName(address) != item.Class || TypeName(info) != ".?AVTalkChatRoomInfo_Mutable@@") continue;
                ulong id = Value(info + 0x18);
                if (id == 0 || seen.Contains(id)) continue;
                StringValue title = ReadString(Value(info + 0x40), true);
                if (title == null || !title.Stable || String.IsNullOrWhiteSpace(title.Text) || title.Text.Length > 256
                    || Value(info + 0x18) != id || Value(address + 0x188) != info) continue;
                result.Add(new RoomChoice { Id = id.ToString(), Title = title.Text }); seen.Add(id);
                if (result.Count >= 512) break;
            }
            return result;
        }
        public List<RoomState> ReadRoomStates(bool refresh)
        {
            if (refresh || DateTime.UtcNow - stateScanAt > TimeSpan.FromSeconds(30))
            {
                SearchResult found = FindObjects(new ulong[] { Table("TalkChatRoom") }, new string[] { ".?AVTalkChatRoom@@" });
                if (found.ScanLimitReached || found.ObjectLimitReached) throw new InvalidOperationException("Room state discovery limit reached.");
                stateRooms.Clear();
                foreach (ObjectHit item in found.Objects) stateRooms.Add(Address(item.Address));
                stateScanAt = DateTime.UtcNow;
            }
            var result = new List<RoomState>(); var seen = new HashSet<ulong>();
            foreach (ulong room in stateRooms)
            {
                ulong info = Value(room + 0x188);
                if (TypeName(room) != ".?AVTalkChatRoom@@" || TypeName(info) != ".?AVTalkChatRoomInfo_Mutable@@") continue;
                byte[] bytes = Read(info + 0x18, 0x70);
                if (bytes == null) continue;
                ulong id = BitConverter.ToUInt64(bytes, 0), latest = BitConverter.ToUInt64(bytes, 0x58);
                uint unread = BitConverter.ToUInt32(bytes, 0x14), seconds = BitConverter.ToUInt32(bytes, 0x40);
                StringValue title = ReadString(BitConverter.ToUInt64(bytes, 0x28), true);
                if (id == 0 || seen.Contains(id) || title == null || !title.Stable || String.IsNullOrWhiteSpace(title.Text) || title.Text.Length > 256 || unread > 1000000000) continue;
                ulong log = Value(room + 0xe8) + 0x20;
                string sender = Value(log) == latest && Value(log + 8) == id ? Value(log + 0x18).ToString() : null;
                byte[] again = Read(info + 0x18, 0x70);
                if (again == null || Value(room + 0x188) != info) continue;
                bool stable = true;
                for (int i = 0; i < bytes.Length; i++) if (bytes[i] != again[i]) { stable = false; break; }
                if (!stable) continue;
                DateTime at = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(seconds);
                result.Add(new RoomState { Id = id.ToString(), Title = title.Text, UnreadCount = unread,
                    LastMessageId = latest == 0 ? null : latest.ToString(), LastSenderId = sender == "0" ? null : sender,
                    LastMessageAt = at.Year >= 2000 && at < DateTime.UtcNow.AddDays(1) ? at.ToString("o") : null });
                seen.Add(id);
                if (result.Count >= 512) break;
            }
            return result;
        }
        public string ReadSelfId()
        {
            string result = null;
            foreach (ulong room in stateRooms)
            {
                ulong info = Value(room + 0x188), db = Value(room + 0xe8);
                if (TypeName(room) != ".?AVTalkChatRoom@@" || TypeName(info) != ".?AVTalkChatRoomInfo_Mutable@@" || db == 0) continue;
                ulong kindPointer = Value(info + 0x20);
                StringValue kind = ReadString(kindPointer, false);
                if (kind == null || !kind.Stable || kind.Text != "MemoChat") continue;
                byte[] members = Read(info + 0x28, 4), first = Read(db + 0x20, 0x20);
                if (members == null || BitConverter.ToUInt32(members, 0) != 1 || first == null) continue;
                ulong roomId = Value(info + 0x18), latest = Value(info + 0x70), sender = BitConverter.ToUInt64(first, 0x18);
                if (roomId == 0 || latest == 0 || sender == 0 || BitConverter.ToUInt64(first, 0) != latest || BitConverter.ToUInt64(first, 8) != roomId) continue;
                byte[] second = Read(db + 0x20, 0x20), membersAgain = Read(info + 0x28, 4);
                StringValue kindAgain = ReadString(kindPointer, false);
                if (second == null || membersAgain == null || BitConverter.ToUInt32(membersAgain, 0) != 1 || kindAgain == null || !kindAgain.Stable || kindAgain.Text != "MemoChat"
                    || Value(room + 0x188) != info || Value(room + 0xe8) != db || Value(info + 0x18) != roomId || Value(info + 0x70) != latest || Value(info + 0x20) != kindPointer) continue;
                bool stable = true;
                for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) { stable = false; break; }
                if (!stable) continue;
                if (result != null && result != sender.ToString()) return null;
                result = sender.ToString();
            }
            return result;
        }
        public List<Field> Fields(ulong address, int length)
        {
            if (length > 2048) throw new ArgumentException("Object reads limited to 2048 bytes.");
            byte[] first = Read(address, length), second = Read(address, length);
            if (first == null || second == null) throw new InvalidOperationException("Object no longer readable.");
            var result = new List<Field>();
            for (int i = 0; i + 8 <= length; i += 8)
            {
                ulong value = BitConverter.ToUInt64(first, i);
                if (value != BitConverter.ToUInt64(second, i)) throw new InvalidOperationException("Object changed during observation.");
                result.Add(new Field { Offset = Hex((ulong)i), Hex = Hex(value), Unsigned = value.ToString(), PointeeType = TypeName(value) });
            }
            return result;
        }
        public string TypeName(ulong instance)
        {
            byte[] pointer = Read(instance, 8);
            if (pointer == null) return null;
            return TableTypeName(BitConverter.ToUInt64(pointer, 0));
        }
        string TableTypeName(ulong vtable)
        {
            if (vtable < ImageBase + 8 || vtable >= ImageBase + (ulong)ImageSize) return null;
            byte[] locatorPointer = Read(vtable - 8, 8);
            if (locatorPointer == null) return null;
            ulong locator = BitConverter.ToUInt64(locatorPointer, 0);
            if (locator < ImageBase || locator + 24 > ImageBase + (ulong)ImageSize) return null;
            byte[] record = Read(locator, 24);
            if (record == null || BitConverter.ToUInt32(record, 0) != 1 || ImageBase + BitConverter.ToUInt32(record, 20) != locator) return null;
            uint descriptor = BitConverter.ToUInt32(record, 12);
            if (descriptor + 272L > ImageSize) return null;
            byte[] name = Read(ImageBase + descriptor + 16, 256);
            if (name == null) return null;
            int end = Array.IndexOf(name, (byte)0);
            if (end < 4) return null;
            string value = Encoding.ASCII.GetString(name, 0, end);
            return value.StartsWith(".?A") ? value : null;
        }
        public StringValue ReadString(ulong pointer, bool wide)
        {
            if (pointer < 0x10020) return null;
            byte[] header = Read(pointer - 0x20, 32);
            if (header == null) return null;
            long length = BitConverter.ToInt64(header, 16);
            if (length < 1 || length > 8192) return null;
            int count = checked((int)(length * (wide ? 2 : 1)));
            byte[] bytes = Read(pointer, count + (wide ? 2 : 1));
            if (bytes == null || bytes[count] != 0 || (wide && bytes[count + 1] != 0)) return null;
            string text;
            try { text = (wide ? (Encoding)new UnicodeEncoding(false, false, true) : new UTF8Encoding(false, true)).GetString(bytes, 0, count); }
            catch (DecoderFallbackException) { return null; }
            byte[] again = Read(pointer, bytes.Length), headerAgain = Read(pointer - 0x20, 32);
            bool stable = again != null && headerAgain != null && BitConverter.ToInt64(headerAgain, 16) == length;
            if (stable) for (int i = 0; i < bytes.Length; i++) if (bytes[i] != again[i]) { stable = false; break; }
            string digest;
            using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
            return new StringValue { Pointer = Hex(pointer), Encoding = wide ? "utf-16le" : "utf-8", Text = text, Length = length, Stable = stable, Sha256 = digest };
        }
        public StringValue ReadStdString(ulong address, bool wide)
        {
            byte[] record = Read(address, 32);
            if (record == null) return null;
            ulong length = BitConverter.ToUInt64(record, 16), capacity = BitConverter.ToUInt64(record, 24);
            if (length == 0 || length > 8192 || capacity < length || capacity > 1024 * 1024) return null;
            ulong pointer = capacity <= (wide ? 7UL : 15UL) ? address : BitConverter.ToUInt64(record, 0);
            int size = checked((int)length * (wide ? 2 : 1));
            byte[] bytes = Read(pointer, size + (wide ? 2 : 1));
            if (bytes == null || bytes[size] != 0 || (wide && bytes[size + 1] != 0)) return null;
            string text;
            try { text = (wide ? (Encoding)new UnicodeEncoding(false, false, true) : new UTF8Encoding(false, true)).GetString(bytes, 0, size); }
            catch (DecoderFallbackException) { return null; }
            byte[] again = Read(pointer, bytes.Length), recordAgain = Read(address, 32);
            bool stable = again != null && recordAgain != null;
            if (stable) for (int i = 0; i < record.Length; i++) if (record[i] != recordAgain[i]) { stable = false; break; }
            if (stable) for (int i = 0; i < bytes.Length; i++) if (bytes[i] != again[i]) { stable = false; break; }
            string digest;
            using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
            return new StringValue { Pointer = Hex(pointer), Encoding = wide ? "utf-16le" : "utf-8", Text = text, Length = (long)length, Stable = stable, Sha256 = digest };
        }
        public byte[] Code(uint rva, int count)
        {
            if (count < 1 || count > 16384 || rva + (long)count > ImageSize) throw new ArgumentException("Invalid code range.");
            return Read(ImageBase + rva, count);
        }
        ulong Value(ulong address)
        {
            byte[] bytes = Read(address, 8);
            if (bytes == null) return 0;
            return BitConverter.ToUInt64(bytes, 0);
        }
        static ulong Address(string hex) { return Convert.ToUInt64(hex.Substring(2), 16); }
        static bool Exact(StringValue value, string expected) { return value != null && value.Stable && String.Equals(value.Text, expected, StringComparison.Ordinal); }
        public ValidationResult Validate(string body, string senderName, string roomName)
        {
            if (String.IsNullOrWhiteSpace(senderName) || String.IsNullOrWhiteSpace(roomName)) throw new ArgumentException("Expected sender and room are required.");
            string[] classes = { ".?AVChatLogContent_Msg@@", ".?AVChatLogContent_TextMsg@@", ".?AVChatLogContent_EmoticonText@@",
                ".?AVTalkChatRoom@@", ".?AVTalkChatRoomInfo_Mutable@@", ".?AVTalkUser_Mutable@@" };
            SearchResult search = Find(body, Tables(classes), classes);
            var result = new ValidationResult { Status = "not-matched", ScannedBytes = search.ScannedBytes,
                ScanLimitReached = search.ScanLimitReached, ObjectLimitReached = search.ObjectLimitReached };
            foreach (ObjectHit ui in search.Objects)
            {
                if (!ui.Class.StartsWith(".?AVChatLogContent_")) continue;
                ulong uiAddress = Address(ui.Address), uiBodyPointer = Value(uiAddress + 0xe8);
                StringValue uiBody = ReadString(uiBodyPointer, true);
                if (!Exact(uiBody, body)) continue;
                ulong roomId = Value(uiAddress + 0x60), messageId = Value(uiAddress + 0x68);
                if (roomId == 0 || messageId == 0 || TypeName(uiAddress) != ui.Class) continue;
                ulong vtable = Value(uiAddress), setter = Value(vtable + 24);
                if (setter < ImageBase || setter >= ImageBase + (ulong)ImageSize) continue;
                uint setterRva = (uint)(setter - ImageBase);
                bool callPath = setterRva == SetterRva;
                int callOffset = ui.Class == ".?AVChatLogContent_EmoticonText@@" ? 0x10 : ui.Class == ".?AVChatLogContent_TextMsg@@" ? 9 : -1;
                if (!callPath && callOffset >= 0)
                {
                    byte[] call = Code(setterRva + (uint)callOffset, 5);
                    callPath = call != null && call[0] == 0xe8 && setterRva + (long)callOffset + 5 + BitConverter.ToInt32(call, 1) == SetterRva;
                }
                if (!callPath) continue;
                foreach (ObjectHit room in search.Objects)
                {
                    if (room.Class != ".?AVTalkChatRoom@@") continue;
                    ulong roomAddress = Address(room.Address), infoAddress = Value(roomAddress + 0x188);
                    if (TypeName(roomAddress) != room.Class || TypeName(infoAddress) != ".?AVTalkChatRoomInfo_Mutable@@" || Value(infoAddress + 0x18) != roomId) continue;
                    StringValue roomText = ReadString(Value(infoAddress + 0x40), true);
                    if (!Exact(roomText, roomName)) continue;
                    ulong dbAddress = Value(roomAddress + 0xe8);
                    // The analyzed build embeds its cached TalkChatLog at ChatDB + 0x20.
                    // Validate its IDs and body; never infer validity from the address alone.
                    ulong input = dbAddress + 0x20;
                    if (Value(input) != messageId || Value(input + 8) != roomId) continue;
                    byte[] messageType = Read(input + 0x10, 4);
                    if (messageType == null || BitConverter.ToUInt32(messageType, 0) != 1) continue;
                    ulong inputBodyPointer = Value(input + 0x30), senderId = Value(input + 0x18);
                    StringValue inputBody = ReadString(inputBodyPointer, false);
                    if (!Exact(inputBody, body) || senderId == 0) continue;
                    foreach (ObjectHit user in search.Objects)
                    {
                        if (user.Class != ".?AVTalkUser_Mutable@@") continue;
                        ulong userAddress = Address(user.Address);
                        if (Value(userAddress + 0x20) != senderId || TypeName(userAddress) != user.Class) continue;
                        StringValue senderText = ReadStdString(userAddress + 0x38, false);
                        if (!Exact(senderText, senderName)) continue;
                        bool stable = Value(uiAddress) == vtable && Value(uiAddress + 0x60) == roomId && Value(uiAddress + 0x68) == messageId
                            && Value(uiAddress + 0xe8) == uiBodyPointer && Value(roomAddress + 0x188) == infoAddress && Value(roomAddress + 0xe8) == dbAddress
                            && Value(infoAddress + 0x18) == roomId && Value(input) == messageId && Value(input + 8) == roomId
                            && Value(input + 0x18) == senderId && Value(input + 0x30) == inputBodyPointer && Value(userAddress + 0x20) == senderId
                            && Exact(ReadString(uiBodyPointer, true), body) && Exact(ReadString(inputBodyPointer, false), body)
                            && Exact(ReadString(Value(infoAddress + 0x40), true), roomName) && Exact(ReadStdString(userAddress + 0x38, false), senderName);
                        if (!stable) continue;
                        result.Messages.Add(new ValidationRecord {
                            BodySha256 = inputBody.Sha256, BodyCharacters = body.Length,
                            SenderName = senderText.Text, SenderId = senderId.ToString(), RoomName = roomText.Text, RoomId = roomId.ToString(), MessageId = messageId.ToString(),
                            UiObject = ui.Address, UiClass = ui.Class, RoomObject = room.Address, RoomInfoObject = Hex(infoAddress), ChatDbObject = Hex(dbAddress),
                            InputObject = Hex(input), SenderObject = user.Address, InputBodyPointer = Hex(inputBodyPointer), UiBodyPointer = Hex(uiBodyPointer),
                            OverrideRva = Hex(setterRva), BaseSetterRva = Hex(SetterRva), BodyExactMatch = true, SenderExactMatch = true,
                            RoomExactMatch = true, Stable = true, CallPathVerified = true, FunctionEntryObserved = false
                        });
                    }
                }
            }
            result.ReadFailures = ReadFailures;
            if (result.Messages.Count > 0) result.Status = "matched";
            return result;
        }
    }
}
