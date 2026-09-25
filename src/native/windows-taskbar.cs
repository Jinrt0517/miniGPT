using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

// This helper only marks miniGPT's own window. Explorer remains responsible
// for taskbar visibility and clears the marking when that window is hidden.
internal static class WindowsTaskbar
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor, WorkArea;
        public uint Flags;
    }

    [ComImport]
    [Guid("56FDF344-FD6D-11D0-958A-006097C9A090")]
    private class TaskbarList { }

    // Include ITaskbarList's methods in order before the ITaskbarList2 method.
    [ComImport]
    [Guid("602D4995-B13A-429B-A66E-1935E44F4317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList2
    {
        [PreserveSig] int HrInit();
        [PreserveSig] int AddTab(IntPtr window);
        [PreserveSig] int DeleteTab(IntPtr window);
        [PreserveSig] int ActivateTab(IntPtr window);
        [PreserveSig] int SetActiveAlt(IntPtr window);
        [PreserveSig] int MarkFullscreenWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int length);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    private static bool IsFullscreenOnTargetMonitor(IntPtr foreground, IntPtr target)
    {
        if (foreground == IntPtr.Zero || !IsWindow(foreground) ||
            !IsWindowVisible(foreground) || IsIconic(foreground) ||
            foreground == GetDesktopWindow() || foreground == GetShellWindow())
            return false;

        StringBuilder className = new StringBuilder(256);
        if (GetClassName(foreground, className, className.Capacity) == 0)
            return false;
        string name = className.ToString();
        if (name == "Progman" || name == "WorkerW" ||
            name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd")
            return false;

        const uint MonitorDefaultToNull = 0;
        IntPtr monitor = MonitorFromWindow(foreground, MonitorDefaultToNull);
        if (monitor == IntPtr.Zero || monitor != MonitorFromWindow(target, MonitorDefaultToNull))
            return false;

        MonitorInfo info = new MonitorInfo();
        info.Size = Marshal.SizeOf(typeof(MonitorInfo));
        Rect bounds;
        if (!GetMonitorInfo(monitor, ref info) || !GetWindowRect(foreground, out bounds))
            return false;

        // Allow rounding at fractional display scales, while a normal maximized
        // window still stops above the taskbar and therefore fails this check.
        const int Tolerance = 2;
        return bounds.Right > bounds.Left && bounds.Bottom > bounds.Top &&
            bounds.Left <= info.Monitor.Left + Tolerance &&
            bounds.Top <= info.Monitor.Top + Tolerance &&
            bounds.Right >= info.Monitor.Right - Tolerance &&
            bounds.Bottom >= info.Monitor.Bottom - Tolerance;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        object taskbar = null;
        try
        {
            long handle;
            if (args.Length != 1 || !long.TryParse(args[0], NumberStyles.None,
                CultureInfo.InvariantCulture, out handle) || handle <= 0)
                return 1;

            // Compare physical window and monitor coordinates on mixed-DPI
            // displays instead of allowing GetWindowRect to be virtualized.
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            IntPtr target = new IntPtr(handle);
            if (!IsWindow(target))
                return 1;

            IntPtr foreground = GetForegroundWindow();
            // Opening settings or changing compact mode can call show again.
            // Keep the existing marking while miniGPT already owns focus.
            if (foreground == target)
                return 0;

            bool preserveFullscreen = IsFullscreenOnTargetMonitor(foreground, target);
            taskbar = new TaskbarList();
            ITaskbarList2 api = (ITaskbarList2)taskbar;
            Marshal.ThrowExceptionForHR(api.HrInit());
            Marshal.ThrowExceptionForHR(api.MarkFullscreenWindow(target, preserveFullscreen));
            return 0;
        }
        catch
        {
            return 1;
        }
        finally
        {
            if (taskbar != null && Marshal.IsComObject(taskbar))
                Marshal.FinalReleaseComObject(taskbar);
        }
    }
}
