param(
  [Parameter(Mandatory = $true)][long]$MainHandle,
  [long]$FullscreenHandle = 0,
  [switch]$FocusFullscreen
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MiniTaskbarProbe {
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
}
'@

# The caller first registers this shortcut on its own fixture window. A real
# shortcut grants foreground activation under Windows' focus-stealing policy.
# Apart from activating the fixture, this probe only reads native window state.
if ($FocusFullscreen) {
  if ($FullscreenHandle -eq 0) { throw 'A fullscreen fixture handle is required to focus it.' }
  try {
    foreach ($key in @(0x11, 0x12, 0x10, 0x79)) { [MiniTaskbarProbe]::keybd_event($key, 0, 0, [UIntPtr]::Zero) }
  } finally {
    foreach ($key in @(0x79, 0x10, 0x12, 0x11)) { [MiniTaskbarProbe]::keybd_event($key, 0, 2, [UIntPtr]::Zero) }
  }
  Start-Sleep -Milliseconds 500
}

$rows = @()
$handle = [MiniTaskbarProbe]::GetTopWindow([IntPtr]::Zero)
$index = 0
while ($handle -ne [IntPtr]::Zero -and $index -lt 10000) {
  $className = New-Object System.Text.StringBuilder 256
  [void][MiniTaskbarProbe]::GetClassName($handle, $className, 256)
  if ($handle.ToInt64() -eq $MainHandle -or $handle.ToInt64() -eq $FullscreenHandle -or $className.ToString() -in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) {
    $rows += [pscustomobject]@{
      handle = $handle.ToInt64()
      z = $index
      class = $className.ToString()
      visible = [MiniTaskbarProbe]::IsWindowVisible($handle)
      style = [MiniTaskbarProbe]::GetWindowLongPtrW($handle, -20).ToInt64()
      monitor = [MiniTaskbarProbe]::MonitorFromWindow($handle, 2).ToInt64()
    }
  }
  $handle = [MiniTaskbarProbe]::GetWindow($handle, 2)
  $index++
}
[pscustomobject]@{ foreground = [MiniTaskbarProbe]::GetForegroundWindow().ToInt64(); windows = $rows } | ConvertTo-Json -Depth 3 -Compress
