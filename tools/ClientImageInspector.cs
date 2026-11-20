using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace LocalChatResearch
{
    public sealed class ImageRange
    {
        public int Start;
        public int Length;
        public bool Executable;
    }
    public sealed class VTableCandidate
    {
        public string Rva;
        public List<string> FunctionRvas = new List<string>();
        public List<CodeReference> CodeReferences = new List<CodeReference>();
    }
    public sealed class CodeReference
    {
        public string InstructionRva;
        public string FunctionBeginRva;
        public string FunctionEndRva;
        public string CodeHex;
    }
    public sealed class LocatorCandidate
    {
        public string Rva;
        public uint ObjectOffset;
        public string HierarchyRva;
        public List<VTableCandidate> VTables = new List<VTableCandidate>();
    }
    public sealed class TypeCandidate
    {
        public string Name;
        public string TypeDescriptorRva;
        public List<LocatorCandidate> Locators = new List<LocatorCandidate>();
    }
    public sealed class Inspection
    {
        public int ProcessId;
        public string ModulePath;
        public string ImageBase;
        public int ImageSize;
        public long ReadableBytes;
        public int ReadFailures;
        public int RttiNameCount;
        public List<TypeCandidate> Candidates = new List<TypeCandidate>();
        public string Limitation = "RTTI and vtable candidates only. No message contents, object fields or function behavior verified.";
    }

    // The target handle has QUERY_INFORMATION | VM_READ only. No target writes,
    // thread creation, debugger attach, network calls or heap scans are provided.
    public static class ClientImageInspector
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MemoryInfo
        {
            public IntPtr BaseAddress;
            public IntPtr AllocationBase;
            public uint AllocationProtect;
            public ushort PartitionId;
            public UIntPtr RegionSize;
            public uint State;
            public uint Protect;
            public uint Type;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer,
            UIntPtr size, out UIntPtr read);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address,
            out MemoryInfo info, UIntPtr length);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        static string Hex(ulong value) { return "0x" + value.ToString("X"); }
        static bool Contains(List<ImageRange> ranges, int offset, int length, bool executable)
        {
            foreach (ImageRange range in ranges)
                if (offset >= range.Start && (long)offset + length <= (long)range.Start + range.Length
                    && (!executable || range.Executable)) return true;
            return false;
        }
        static void AddRange(List<ImageRange> ranges, int start, int length, bool executable)
        {
            ImageRange prior = ranges.Count == 0 ? null : ranges[ranges.Count - 1];
            if (prior != null && prior.Start + prior.Length == start && prior.Executable == executable)
                prior.Length += length;
            else ranges.Add(new ImageRange { Start = start, Length = length, Executable = executable });
        }

        public static Inspection Inspect(int processId, string expectedPath, string candidatePattern, bool traceVTables)
        {
            if (IntPtr.Size != 8) throw new InvalidOperationException("Use a 64-bit PowerShell host.");
            using (Process process = Process.GetProcessById(processId))
            {
                ProcessModule module = process.MainModule;
                if (!String.Equals(Path.GetFullPath(module.FileName), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase)
                    || !String.Equals(Path.GetFileName(module.FileName), "KakaoTalk.exe", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Target must match the specified KakaoTalk.exe path.");
                int size = module.ModuleMemorySize;
                if (size < 4096 || size > 128 * 1024 * 1024) throw new InvalidOperationException("Unexpected image size.");
                ulong imageBase = (ulong)module.BaseAddress.ToInt64();
                byte[] image = new byte[size];
                var ranges = new List<ImageRange>();
                int failures = 0;
                long readable = 0;
                IntPtr handle = OpenProcess(0x0410, false, processId);
                if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    ulong address = imageBase;
                    ulong imageEnd = imageBase + (ulong)size;
                    while (address < imageEnd)
                    {
                        MemoryInfo info;
                        if (VirtualQueryEx(handle, new IntPtr((long)address), out info,
                            new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryInfo)))) == UIntPtr.Zero)
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        ulong end = Math.Min(imageEnd, (ulong)info.BaseAddress.ToInt64() + info.RegionSize.ToUInt64());
                        if (end <= address) throw new InvalidOperationException("Invalid memory region size.");
                        uint access = info.Protect & 0xff;
                        bool canRead = access == 2 || access == 4 || access == 8 || access == 0x20 || access == 0x40 || access == 0x80;
                        bool executable = access == 0x20 || access == 0x40 || access == 0x80;
                        if (info.State == 0x1000 && info.Type == 0x1000000 &&
                            (ulong)info.AllocationBase.ToInt64() == imageBase &&
                            (info.Protect & 0x100) == 0 && canRead)
                        {
                            for (ulong at = address; at < end; )
                            {
                                int count = (int)Math.Min(1024UL * 1024UL, end - at);
                                byte[] block = new byte[count];
                                UIntPtr bytesRead;
                                bool success = ReadProcessMemory(handle, new IntPtr((long)at), block, new UIntPtr((uint)count), out bytesRead);
                                if (success && bytesRead.ToUInt64() == (ulong)count)
                                {
                                    int offset = (int)(at - imageBase);
                                    Buffer.BlockCopy(block, 0, image, offset, count);
                                    AddRange(ranges, offset, count, executable);
                                    readable += count;
                                }
                                else failures++;
                                at += (ulong)count;
                            }
                        }
                        address = end;
                    }
                }
                finally { CloseHandle(handle); }
                try
                {
                    if (image[0] != 0x4d || image[1] != 0x5a) throw new InvalidOperationException("Loaded DOS header is unavailable.");
                    int pe = BitConverter.ToInt32(image, 0x3c);
                    if (pe < 0 || pe + 26 > size || !Contains(ranges, pe, 26, false) ||
                        BitConverter.ToUInt32(image, pe) != 0x4550 || BitConverter.ToUInt16(image, pe + 4) != 0x8664)
                        throw new InvalidOperationException("Expected an x64 PE image.");
                    Inspection result = Analyze(image, imageBase, ranges, candidatePattern);
                    if (traceVTables) TraceVTables(image, imageBase, ranges, result);
                    result.ProcessId = processId;
                    result.ModulePath = module.FileName;
                    result.ReadableBytes = readable;
                    result.ReadFailures = failures;
                    return result;
                }
                finally { Array.Clear(image, 0, image.Length); }
            }
        }

        public static Inspection Analyze(byte[] image, ulong imageBase, List<ImageRange> ranges, string candidatePattern)
        {
            var result = new Inspection { ImageBase = Hex(imageBase), ImageSize = image.Length };
            var filter = new Regex(candidatePattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
                TimeSpan.FromSeconds(1));
            var types = new Dictionary<uint, TypeCandidate>();
            foreach (ImageRange range in ranges)
            {
                int end = range.Start + range.Length;
                for (int i = Math.Max(16, range.Start); i + 6 < end; i++)
                {
                    if (image[i] != '.' || image[i + 1] != '?' || image[i + 2] != 'A' ||
                        (image[i + 3] != 'V' && image[i + 3] != 'U')) continue;
                    int cursor = i + 4;
                    while (cursor < Math.Min(end, i + 1024) && image[cursor] > 32 && image[cursor] < 127) cursor++;
                    if (cursor >= end || image[cursor] != 0 || image[cursor - 1] != '@' ||
                        !Contains(ranges, i - 16, cursor - i + 17, false)) continue;
                    string name = Encoding.ASCII.GetString(image, i, cursor - i);
                    result.RttiNameCount++;
                    if (!filter.IsMatch(name)) continue;
                    uint descriptor = (uint)(i - 16);
                    var type = new TypeCandidate { Name = name, TypeDescriptorRva = Hex(descriptor) };
                    types[descriptor] = type;
                    result.Candidates.Add(type);
                    i = cursor;
                }
            }
            var locators = new Dictionary<ulong, LocatorCandidate>();
            foreach (ImageRange range in ranges)
            {
                int start = (range.Start + 3) & ~3;
                int end = range.Start + range.Length;
                for (int i = start; i + 24 <= end; i += 4)
                {
                    if (BitConverter.ToUInt32(image, i) != 1 || BitConverter.ToUInt32(image, i + 20) != (uint)i) continue;
                    TypeCandidate type;
                    uint descriptor = BitConverter.ToUInt32(image, i + 12);
                    uint hierarchy = BitConverter.ToUInt32(image, i + 16);
                    if (!types.TryGetValue(descriptor, out type) || hierarchy > Int32.MaxValue ||
                        !Contains(ranges, (int)hierarchy, 16, false)) continue;
                    var locator = new LocatorCandidate {
                        Rva = Hex((uint)i), ObjectOffset = BitConverter.ToUInt32(image, i + 4), HierarchyRva = Hex(hierarchy)
                    };
                    type.Locators.Add(locator);
                    locators[imageBase + (ulong)i] = locator;
                }
            }
            foreach (ImageRange range in ranges)
            {
                int start = (range.Start + 7) & ~7;
                int end = range.Start + range.Length;
                for (int i = start; i + 16 <= end; i += 8)
                {
                    LocatorCandidate locator;
                    if (!locators.TryGetValue(BitConverter.ToUInt64(image, i), out locator)) continue;
                    var table = new VTableCandidate { Rva = Hex((uint)(i + 8)) };
                    for (int slot = 0; slot < 128 && i + 16 + slot * 8 <= end; slot++)
                    {
                        ulong address = BitConverter.ToUInt64(image, i + 8 + slot * 8);
                        if (address < imageBase || address - imageBase >= (ulong)image.Length ||
                            !Contains(ranges, (int)(address - imageBase), 1, true)) break;
                        table.FunctionRvas.Add(Hex(address - imageBase));
                    }
                    if (table.FunctionRvas.Count > 0) locator.VTables.Add(table);
                }
            }
            return result;
        }

        // Record RIP-relative LEA references to observed tables. The exception
        // directory supplies containing function bounds, not a function name.
        static void TraceVTables(byte[] image, ulong imageBase, List<ImageRange> ranges, Inspection inspection)
        {
            var tables = new Dictionary<int, VTableCandidate>();
            foreach (TypeCandidate type in inspection.Candidates)
                foreach (LocatorCandidate locator in type.Locators)
                    foreach (VTableCandidate table in locator.VTables)
                        tables[Convert.ToInt32(table.Rva.Substring(2), 16)] = table;
            int pdata = 0;
            int functionCount = 0;
            if (image.Length >= 64 && image[0] == 'M' && image[1] == 'Z')
            {
                int pe = BitConverter.ToInt32(image, 0x3c);
                if (pe >= 0 && pe + 168 <= image.Length && Contains(ranges, pe, 168, false) &&
                    BitConverter.ToUInt32(image, pe) == 0x4550 && BitConverter.ToUInt16(image, pe + 24) == 0x20b)
                {
                    pdata = BitConverter.ToInt32(image, pe + 160);
                    uint directorySize = BitConverter.ToUInt32(image, pe + 164);
                    if (pdata > 0 && directorySize <= 12 * 1000000 && Contains(ranges, pdata, (int)directorySize, false))
                        functionCount = (int)directorySize / 12;
                }
            }
            foreach (ImageRange range in ranges)
            {
                if (!range.Executable) continue;
                int end = range.Start + range.Length;
                for (int at = range.Start; at + 7 <= end; at++)
                {
                    if ((image[at] & 0xf8) != 0x48 || image[at + 1] != 0x8d || (image[at + 2] & 0xc7) != 5) continue;
                    long target = (long)at + 7 + BitConverter.ToInt32(image, at + 3);
                    VTableCandidate table;
                    if (target < 0 || target > Int32.MaxValue || !tables.TryGetValue((int)target, out table) || table.CodeReferences.Count >= 16) continue;
                    var reference = new CodeReference { InstructionRva = Hex((uint)at) };
                    int lo = 0, hi = functionCount - 1;
                    while (lo <= hi)
                    {
                        int mid = lo + (hi - lo) / 2;
                        int entry = pdata + mid * 12;
                        uint begin = BitConverter.ToUInt32(image, entry);
                        uint finish = BitConverter.ToUInt32(image, entry + 4);
                        if (at < begin) hi = mid - 1;
                        else if (at >= finish) lo = mid + 1;
                        else
                        {
                            if (begin < finish && finish <= image.Length && Contains(ranges, (int)begin, (int)(finish - begin), true))
                            {
                                reference.FunctionBeginRva = Hex(begin);
                                reference.FunctionEndRva = Hex(finish);
                                int count = Math.Min(1024, (int)(finish - begin));
                                reference.CodeHex = BitConverter.ToString(image, (int)begin, count).Replace("-", "");
                            }
                            break;
                        }
                    }
                    table.CodeReferences.Add(reference);
                }
            }
        }

        public static string[] SelfTest()
        {
            byte[] image = new byte[4096];
            ulong imageBase = 0x140000000;
            byte[] name = Encoding.ASCII.GetBytes(".?AVChatMessage@@\0");
            Buffer.BlockCopy(name, 0, image, 0x110, name.Length);
            Action<int, uint> put32 = (at, value) => Buffer.BlockCopy(BitConverter.GetBytes(value), 0, image, at, 4);
            Action<int, ulong> put64 = (at, value) => Buffer.BlockCopy(BitConverter.GetBytes(value), 0, image, at, 8);
            put32(0x200, 1); put32(0x20c, 0x100); put32(0x210, 0x300); put32(0x214, 0x200);
            put64(0x400, imageBase + 0x200); put64(0x408, imageBase + 0x800); put64(0x410, imageBase + 0x820);
            var ranges = new List<ImageRange> {
                new ImageRange { Start = 0, Length = 0x800 },
                new ImageRange { Start = 0x800, Length = 0x800, Executable = true }
            };
            Inspection result = Analyze(image, imageBase, ranges, "chat|message");
            if (result.Candidates.Count != 1 || result.Candidates[0].Locators.Count != 1 ||
                result.Candidates[0].Locators[0].VTables.Count != 1 ||
                result.Candidates[0].Locators[0].VTables[0].FunctionRvas.Count != 2)
                throw new Exception("RTTI/COL/vtable reconstruction failed.");
            image[0x800] = 0x48; image[0x801] = 0x8d; image[0x802] = 5;
            put32(0x803, unchecked((uint)(0x408 - 0x807)));
            image[0] = (byte)'M'; image[1] = (byte)'Z';
            put32(0x3c, 0x40); put32(0x40, 0x4550);
            image[0x58] = 0x0b; image[0x59] = 2;
            put32(0xe0, 0x600); put32(0xe4, 12);
            put32(0x600, 0x800); put32(0x604, 0x840); put32(0x608, 0x700);
            TraceVTables(image, imageBase, ranges, result);
            if (result.Candidates[0].Locators[0].VTables[0].CodeReferences.Count != 1 ||
                result.Candidates[0].Locators[0].VTables[0].CodeReferences[0].InstructionRva != "0x800")
                throw new Exception("RIP-relative table reference was not found.");
            CodeReference code = result.Candidates[0].Locators[0].VTables[0].CodeReferences[0];
            if (code.FunctionBeginRva != "0x800" || code.FunctionEndRva != "0x840" || code.CodeHex.Length != 128)
                throw new Exception("Exception-directory function bounds were not respected.");
            if (Analyze(image, imageBase, ranges, "unrelated").Candidates.Count != 0)
                throw new Exception("Name filter failed.");
            put32(0x214, 0x204);
            if (Analyze(image, imageBase, ranges, "chat").Candidates[0].Locators.Count != 0)
                throw new Exception("Invalid self-RVA accepted.");
            put32(0x214, 0x200); put64(0x408, imageBase + 0x500);
            if (Analyze(image, imageBase, ranges, "chat").Candidates[0].Locators[0].VTables.Count != 0)
                throw new Exception("Non-executable function pointer accepted.");
            if (Analyze(image, imageBase, new List<ImageRange> { ranges[1] }, "chat").Candidates.Count != 0)
                throw new Exception("Unread memory range was analyzed.");
            return new[] { "RTTI/COL/vtable reconstruction", "RIP-relative table reference", "exception-directory function bounds", "name filter", "invalid self-RVA rejection", "non-executable pointer rejection", "unread range exclusion" };
        }
    }
}
