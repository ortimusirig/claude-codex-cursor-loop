param([int]$RootPid)

# taskkill /T is the fast path. This fallback enumerates descendants without WMI/CIM,
# which can be denied in constrained hosts even when terminating our own child is allowed.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CccProcessTree {
  const uint TH32CS_SNAPPROCESS = 2;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static void Visit(uint parent, Dictionary<uint, List<uint>> children, List<uint> found) {
    List<uint> direct;
    if (!children.TryGetValue(parent, out direct)) return;
    foreach (var child in direct) {
      Visit(child, children, found);
      found.Add(child); // deepest-first so parents cannot orphan descendants
    }
  }

  public static uint[] Descendants(uint root) {
    var found = new List<uint>();
    var children = new Dictionary<uint, List<uint>>();
    var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(entry);
      if (Process32FirstW(snapshot, ref entry)) do {
        List<uint> direct;
        if (!children.TryGetValue(entry.th32ParentProcessID, out direct)) {
          direct = new List<uint>();
          children.Add(entry.th32ParentProcessID, direct);
        }
        direct.Add(entry.th32ProcessID);
      } while (Process32NextW(snapshot, ref entry));
    } finally {
      CloseHandle(snapshot);
    }
    Visit(root, children, found);
    return found.ToArray();
  }
}
'@

[CccProcessTree]::Descendants([uint32]$RootPid)
