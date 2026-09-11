using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using UiaRect = System.Windows.Rect;
using UiaPoint = System.Windows.Point;

namespace CodexLink.Computer;

internal sealed class ComputerException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
internal sealed record Bounds(double X, double Y, double Width, double Height)
{
    internal bool Contains(double x, double y) => x >= X && y >= Y && x < X + Width && y < Y + Height;
    internal bool Matches(Bounds other) => Math.Abs(X - other.X) < 1 && Math.Abs(Y - other.Y) < 1 && Math.Abs(Width - other.Width) < 1 && Math.Abs(Height - other.Height) < 1;
}
internal sealed record Target(string WindowId, int Pid, string ProcessStart, string AppId, string AppName, string Executable, string Title, Bounds Bounds, bool Onscreen, bool Frontmost, bool Blocked, string BlockReason);

internal sealed class WindowsComputer(JsonElement request)
{
    internal static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, MaxDepth = 32 };
    private readonly HashSet<int> ownerPids = request.TryGetProperty("ownerPids", out var owners) ? owners.EnumerateArray().Select(x => x.GetInt32()).ToHashSet() : [];
    private static readonly HashSet<string> BlockedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "codex link.exe", "codex-link-computer.exe", "codex.exe", "chatgpt.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "wt.exe", "conhost.exe", "openconsole.exe", "bash.exe", "wsl.exe", "mintty.exe", "consent.exe", "logonui.exe", "credentialuibroker.exe", "systemsettings.exe", "regedit.exe", "mmc.exe", "applicationframehost.exe"
    };
    internal static void Require(bool condition, string code, string message)
    {
        if (!condition) throw new ComputerException(code, message);
    }
    private static string Text(JsonElement value, string key, int maximum = 4096)
    {
        Require(value.TryGetProperty(key, out var found) && found.ValueKind == JsonValueKind.String, "invalid_request", $"Missing {key}");
        string result = found.GetString()!;
        Require(result.Length > 0 && result.Length <= maximum, "invalid_request", $"Invalid {key}");
        return result;
    }
    private static int Integer(JsonElement value, string key, int fallback, int minimum, int maximum)
    {
        if (!value.TryGetProperty(key, out var found)) return fallback;
        Require(found.TryGetInt32(out int result) && result >= minimum && result <= maximum, "invalid_request", $"Invalid {key}");
        return result;
    }
    private static bool Boolean(JsonElement value, string key, bool fallback = false) => value.TryGetProperty(key, out var found) ? found.GetBoolean() : fallback;
    private static double Number(JsonElement value, string key)
    {
        Require(value.TryGetProperty(key, out var found) && found.TryGetDouble(out _), "invalid_request", $"Invalid {key}");
        double result = found.GetDouble();
        Require(double.IsFinite(result), "invalid_request", $"Nonfinite {key}");
        return result;
    }
    private static string Limited(string? value) => value is null ? "" : value[..Math.Min(value.Length, 1000)];
    private static string Hash(object value) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions))).ToLowerInvariant();
    private static bool Elevated(nint process)
    {
        Require(Win32.OpenProcessToken(process, 0x0008, out var token), "process_identity", "Cannot verify process elevation.");
        try
        {
            Require(Win32.GetTokenInformation(token, 20, out int elevated, sizeof(int), out _), "process_identity", "Cannot read process elevation.");
            return elevated != 0;
        }
        finally { Win32.CloseHandle(token); }
    }
    private static bool SessionAvailable()
    {
        nint desktop = Win32.OpenInputDesktop(0, false, 0x0001);
        if (desktop == 0) return false;
        try
        {
            var name = new StringBuilder(256);
            return Win32.GetUserObjectInformation(desktop, 2, name, 512, out _) && name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { Win32.CloseDesktop(desktop); }
    }
    private static void CheckSession()
    {
        Require(SessionAvailable(), "session_locked", "Unlock the active Windows desktop locally. Secure desktops and locked use are not supported.");
        using var current = Process.GetCurrentProcess();
        Require(!Elevated(current.Handle), "elevated_helper", "Run Codex Link as a normal, non-elevated desktop user.");
    }
    private Target Describe(nint window)
    {
        Require(Win32.IsWindow(window) && Win32.IsWindowVisible(window), "window_missing", "The window no longer exists or is not visible.");
        Win32.GetWindowThreadProcessId(window, out uint pid);
        Require(pid != 0 && pid <= int.MaxValue && Win32.GetWindowRect(window, out _), "window_missing", "Cannot resolve window identity.");
        Win32.GetWindowRect(window, out var r);
        Require(r.Right > r.Left && r.Bottom > r.Top, "invalid_geometry", "Window has no usable geometry.");
        nint handle = Win32.OpenProcess(0x1000, false, pid);
        Require(handle != 0, "process_identity", "Cannot inspect the target process without elevation.");
        try
        {
            var executable = new StringBuilder(32768); uint length = 32768;
            Require(Win32.QueryFullProcessImageName(handle, 0, executable, ref length), "process_identity", "Cannot verify executable identity.");
            string path = Path.GetFullPath(executable.ToString()).ToLowerInvariant();
            string filename = Path.GetFileName(path);
            uint appLength = 0;
            int appResult = Win32.GetApplicationUserModelId(handle, ref appLength, null);
            string appId = "path:" + path;
            if (appResult == 122 && appLength is > 0 and < 2048)
            {
                var app = new StringBuilder((int)appLength);
                if (Win32.GetApplicationUserModelId(handle, ref appLength, app) == 0) appId = "aumid:" + app;
            }
            using var process = Process.GetProcessById((int)pid);
            string started = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
            var title = new StringBuilder(1001); Win32.GetWindowText(window, title, title.Capacity);
            bool elevated = Elevated(handle);
            bool blocked = elevated || ownerPids.Contains((int)pid) || BlockedNames.Contains(filename);
            int cloaked = 0; _ = Win32.DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int));
            return new Target(window.ToInt64().ToString(CultureInfo.InvariantCulture), (int)pid, started, appId, process.ProcessName, path, title.ToString(),
                new Bounds(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top), !Win32.IsIconic(window) && cloaked == 0,
                Win32.GetForegroundWindow() == window, blocked,
                elevated ? "Elevated applications cannot be automated." : blocked ? "Control panels, terminals, credential/security interfaces, ambiguous app hosts and the controlling agent are not targets." : "");
        }
        finally { Win32.CloseHandle(handle); }
    }
    private static nint Handle(string id)
    {
        Require(long.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out long value) && value != 0, "invalid_window", "Invalid window identifier.");
        return checked((nint)value);
    }
    private Target Verify(Target expected)
    {
        var current = Describe(Handle(expected.WindowId));
        Require(current.WindowId == expected.WindowId && current.Pid == expected.Pid && current.ProcessStart == expected.ProcessStart && current.AppId == expected.AppId && current.Executable == expected.Executable,
            "target_changed", "The application or window identity changed; request a new session.");
        Require(!current.Blocked, "blocked_app", current.BlockReason);
        Require(current.Onscreen, "window_hidden", "Keep the target window restored on the active desktop.");
        return current;
    }
    private List<Target> Windows()
    {
        var windows = new List<Target>();
        Win32.EnumWindows((window, _) =>
        {
            if (windows.Count >= 256) return false;
            try { if (Win32.IsWindowVisible(window)) windows.Add(Describe(window)); }
            catch (Exception ex) when (ex is ComputerException or System.ComponentModel.Win32Exception or InvalidOperationException or ArgumentException) { }
            return true;
        }, 0);
        return windows;
    }
    private static Bounds Rectangle(UiaRect r) => r.IsEmpty || !double.IsFinite(r.X) || !double.IsFinite(r.Y) || !double.IsFinite(r.Width) || !double.IsFinite(r.Height) ? new Bounds(0, 0, 0, 0) : new Bounds(r.X, r.Y, r.Width, r.Height);
    private static Dictionary<string, object?> DescribeElement(AutomationElement element)
    {
        var current = element.Current;
        bool secure = current.IsPassword;
        string role = current.ControlType.ProgrammaticName, name = secure ? "[protected]" : Limited(current.Name);
        string automationId = Limited(current.AutomationId), className = Limited(current.ClassName);
        var bounds = Rectangle(current.BoundingRectangle);
        var result = new Dictionary<string, object?>
        {
            ["role"] = role, ["name"] = name, ["automationId"] = automationId, ["className"] = className,
            ["bounds"] = bounds, ["protected"] = secure, ["enabled"] = current.IsEnabled,
            ["fingerprint"] = Hash(new object[] { element.GetRuntimeId(), role, name, automationId, className, bounds })
        };
        var patterns = element.GetSupportedPatterns().Select(p => p.ProgrammaticName).ToArray();
        result["actions"] = patterns;
        if (!secure && element.TryGetCurrentPattern(ValuePattern.Pattern, out object value)) result["value"] = Limited(((ValuePattern)value).Current.Value);
        return result;
    }
    private static List<AutomationElement> Children(AutomationElement element)
    {
        var result = new List<AutomationElement>();
        var walker = TreeWalker.ControlViewWalker;
        for (var child = walker.GetFirstChild(element); child is not null && result.Count < 500; child = walker.GetNextSibling(child)) result.Add(child);
        return result;
    }
    private static (List<Dictionary<string, object?>> Elements, bool Truncated) Tree(AutomationElement root, int maxNodes, int maxDepth)
    {
        var nodes = new List<Dictionary<string, object?>>();
        var seen = new HashSet<string>();
        var watch = Stopwatch.StartNew(); bool truncated = false;
        void Visit(AutomationElement element, int[] path)
        {
            if (nodes.Count >= maxNodes || watch.ElapsedMilliseconds > 3000) { truncated = true; return; }
            try
            {
                if (!seen.Add(string.Join("-", element.GetRuntimeId()))) return;
                var node = DescribeElement(element); node["id"] = "e" + nodes.Count; node["path"] = path; nodes.Add(node);
                if (element.Current.IsPassword) return;
                if (path.Length >= maxDepth) { truncated = true; return; }
                int index = 0;
                foreach (var child in Children(element))
                {
                    if (nodes.Count >= maxNodes || watch.ElapsedMilliseconds > 3000) { truncated = true; break; }
                    Visit(child, [.. path, index++]);
                }
            }
            catch (ElementNotAvailableException) { truncated = true; }
        }
        Visit(root, []);
        return (nodes, truncated);
    }
    private static AutomationElement Resolve(AutomationElement root, JsonElement reference)
    {
        int[] path = reference.GetProperty("path").EnumerateArray().Select(x => x.GetInt32()).ToArray();
        Require(path.Length <= 12, "invalid_element", "Element path is too deep.");
        var element = root;
        foreach (int index in path)
        {
            Require(!element.Current.IsPassword, "protected_element", "Protected content cannot be automated.");
            var children = Children(element);
            Require(index >= 0 && index < children.Count, "stale_element", "Element changed; observe again.");
            element = children[index];
        }
        var descriptor = DescribeElement(element);
        Require((string)descriptor["fingerprint"]! == Text(reference, "fingerprint", 128), "stale_element", "Element identity changed; observe again.");
        Require(!element.Current.IsPassword && element.Current.IsEnabled, "protected_element", "Element is protected or disabled.");
        return element;
    }
    private static T Pattern<T>(AutomationElement element, AutomationPattern pattern) where T : class
    {
        Require(element.TryGetCurrentPattern(pattern, out var value) && value is T, "unsupported_action", "This app does not expose the requested UI Automation pattern. No input fallback was attempted.");
        return (T)value;
    }
    private static (object Frame, byte[] Data, string Method) Capture(Target target, int maximumSide)
    {
        nint window = Handle(target.WindowId);
        if (Win32.GetWindowDisplayAffinity(window, out uint affinity)) Require(affinity == 0, "protected_capture", "This window excludes its contents from capture.");
        int width = checked((int)target.Bounds.Width), height = checked((int)target.Bounds.Height);
        Require(width > 0 && height > 0 && (long)width * height <= 40_000_000, "capture_too_large", "Window capture dimensions exceed the safety limit.");
        Bitmap captured;
        Bounds captureBounds;
        string method;
        if (WindowsCapture.Supported)
        {
            var modern = WindowsCapture.Capture(target);
            captured = modern.Image; captureBounds = modern.Bounds; method = "Windows.Graphics.Capture";
            width = captured.Width; height = captured.Height;
        }
        else
        {
            captured = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            captureBounds = target.Bounds; method = "PrintWindow (WGC unsupported)";
            try
            {
                using var graphics = Graphics.FromImage(captured);
                graphics.Clear(Color.Black);
                nint dc = graphics.GetHdc();
                try { Require(Win32.PrintWindow(window, dc, 2), "capture_unavailable", "The application did not render a window capture. No desktop-wide fallback was used."); }
                finally { graphics.ReleaseHdc(dc); }
            }
            catch { captured.Dispose(); throw; }
        }
        using var original = captured;
        bool nonBlack = false;
        for (int y = 0; y < height && !nonBlack; y += Math.Max(1, height / 32))
            for (int x = 0; x < width; x += Math.Max(1, width / 32))
            { var pixel = original.GetPixel(x, y); if (pixel.R + pixel.G + pixel.B > 8) { nonBlack = true; break; } }
        Require(nonBlack, "blank_capture", "The window returned a blank image, possibly an unsupported GPU surface. Use accessibility context or restore the app locally.");
        double scale = Math.Min(1, (double)maximumSide / Math.Max(width, height));
        int imageWidth = Math.Max(1, (int)Math.Round(width * scale)), imageHeight = Math.Max(1, (int)Math.Round(height * scale));
        using var resized = new Bitmap(imageWidth, imageHeight, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(resized))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(original, new System.Drawing.Rectangle(0, 0, imageWidth, imageHeight));
        }
        using var stream = new MemoryStream();
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 86L);
        resized.Save(stream, ImageCodecInfo.GetImageEncoders().First(e => e.MimeType == "image/jpeg"), parameters);
        Require(stream.Length <= 5 * 1024 * 1024, "capture_too_large", "Reduce maxImageSide to fit the output limit.");
        return (new { captureBounds.X, captureBounds.Y, captureBounds.Width, captureBounds.Height, imageWidth, imageHeight }, stream.ToArray(), method);
    }
    private static void FailSafe()
    {
        Require((Win32.GetAsyncKeyState(0x1B) & 0x8000) == 0, "failsafe", "Escape is held. Input has been stopped.");
        if (Win32.GetCursorPos(out var p))
            foreach (var screen in System.Windows.Forms.Screen.AllScreens)
            {
                var r = screen.Bounds;
                bool x = Math.Abs(p.X - r.Left) <= 2 || Math.Abs(p.X - (r.Right - 1)) <= 2;
                bool y = Math.Abs(p.Y - r.Top) <= 2 || Math.Abs(p.Y - (r.Bottom - 1)) <= 2;
                Require(!(x && y), "failsafe", "Mouse-corner fail-safe triggered. Move the pointer away locally.");
            }
    }
    private static void CheckFocus(nint window, AutomationElement root, bool keyboard)
    {
        Require(Win32.GetForegroundWindow() == window, "focus_changed", "The target is not the foreground window. Use focus in a foreground session and then observe again.");
        // Do not release or overwrite modifiers/buttons held by the owner.
        foreach (int key in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01, 0x02, 0x04 })
            Require((Win32.GetAsyncKeyState(key) & 0x8000) == 0, "human_input", "A modifier or mouse button is held. Input has not been sent.");
        if (keyboard)
        {
            var focus = AutomationElement.FocusedElement;
            Require(focus is not null && !focus.Current.IsPassword, "protected_element", "Focused element is unavailable or protected.");
            var ancestor = focus; bool matched = false;
            for (int i = 0; ancestor is not null && i < 32; i++, ancestor = TreeWalker.ControlViewWalker.GetParent(ancestor))
                if (Automation.Compare(ancestor, root)) { matched = true; break; }
            Require(matched, "focus_changed", "Keyboard focus is outside the approved window.");
        }
    }
    internal static int Normalize(double coordinate, int origin, int size)
    {
        Require(size > 1 && coordinate >= origin && coordinate < (double)origin + size, "outside_desktop", "Coordinate is outside the virtual desktop.");
        return Math.Clamp((int)Math.Round((coordinate - origin) * 65535 / (size - 1)), 0, 65535);
    }
    private static Win32.Input Mouse(uint flags, double? x = null, double? y = null, int data = 0)
    {
        var input = new Win32.Input { Type = 0 };
        input.Data.Mouse.Flags = flags; input.Data.Mouse.MouseData = unchecked((uint)data); input.Data.Mouse.ExtraInfo = 0x434C4E41;
        if (x.HasValue && y.HasValue)
        {
            input.Data.Mouse.Dx = Normalize(x.Value, Win32.GetSystemMetrics(76), Win32.GetSystemMetrics(78));
            input.Data.Mouse.Dy = Normalize(y.Value, Win32.GetSystemMetrics(77), Win32.GetSystemMetrics(79));
            input.Data.Mouse.Flags |= 0x8000 | 0x4000 | 0x0001 | 0x2000;
        }
        return input;
    }
    internal static Win32.Input Key(ushort key, bool up, bool unicode = false)
    {
        var input = new Win32.Input { Type = 1 };
        input.Data.Keyboard.Vk = unicode ? (ushort)0 : key;
        input.Data.Keyboard.Scan = unicode ? key : (ushort)0;
        input.Data.Keyboard.Flags = (up ? 0x0002u : 0) | (unicode ? 0x0004u : 0);
        if (!unicode && key is 0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 or 0x2D or 0x2E or 0x5B or 0x5C) input.Data.Keyboard.Flags |= 1;
        input.Data.Keyboard.ExtraInfo = 0x434C4E41;
        return input;
    }
    internal static ushort[] Chord(string[] keys)
    {
        Require(keys.Length is >= 1 and <= 5, "invalid_keys", "Provide one to five keys.");
        var aliases = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            ["ctrl"] = 0x11, ["control"] = 0x11, ["shift"] = 0x10, ["alt"] = 0x12, ["option"] = 0x12, ["win"] = 0x5B, ["meta"] = 0x5B,
            ["enter"] = 0x0D, ["return"] = 0x0D, ["tab"] = 0x09, ["space"] = 0x20, ["backspace"] = 0x08, ["escape"] = 0x1B, ["esc"] = 0x1B,
            ["left"] = 0x25, ["up"] = 0x26, ["right"] = 0x27, ["down"] = 0x28, ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["pagedown"] = 0x22, ["delete"] = 0x2E, ["insert"] = 0x2D
        };
        var modifiers = new List<ushort>(); var ordinary = new List<ushort>();
        foreach (string item in keys)
        {
            string key = item.ToLowerInvariant(); ushort value;
            if (aliases.TryGetValue(key, out ushort alias)) value = alias;
            else if (key.Length == 1 && char.IsAsciiLetterOrDigit(key[0])) value = char.ToUpperInvariant(key[0]);
            else if (key.StartsWith('f') && int.TryParse(key.AsSpan(1), out int f) && f is >= 1 and <= 24) value = (ushort)(0x6F + f);
            else throw new ComputerException("invalid_keys", "Unsupported key name. Use type for Unicode text.");
            if (value is 0x10 or 0x11 or 0x12 or 0x5B) modifiers.Add(value); else ordinary.Add(value);
        }
        Require(ordinary.Count == 1 && modifiers.Distinct().Count() == modifiers.Count, "invalid_keys", "Use distinct modifiers and exactly one non-modifier key.");
        return [.. modifiers, .. ordinary];
    }
    private static void Send(Win32.Input[] inputs)
    {
        // A single SendInput call preserves event order, including key/button releases.
        uint sent = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Win32.Input>());
        if (sent != inputs.Length)
        {
            var releases = inputs.Where(i => i.Type == 1 && (i.Data.Keyboard.Flags & 2) != 0 || i.Type == 0 && (i.Data.Mouse.Flags & (4 | 16 | 64)) != 0).ToArray();
            if (releases.Length > 0) _ = Win32.SendInput((uint)releases.Length, releases, Marshal.SizeOf<Win32.Input>());
            throw new ComputerException("input_rejected", "Windows rejected all or part of the input, possibly due to UIPI. No elevation or security-boundary bypass was attempted. Observe before retrying.");
        }
    }
    private object Interact(Target target)
    {
        nint window = Handle(target.WindowId), oldForeground = Win32.GetForegroundWindow();
        string action = Text(request, "action", 32), mode = Text(request, "mode", 16);
        Require(mode is "foreground" or "background", "invalid_mode", "Invalid input mode.");
        var frame = request.GetProperty("target").GetProperty("bounds").Deserialize<Bounds>(JsonOptions)!;
        Require(target.Bounds.Matches(frame), "stale_frame", "The window moved or resized; observe again.");
        FailSafe();
        var root = AutomationElement.FromHandle(window);
        if (request.TryGetProperty("element", out var reference))
        {
            var element = Resolve(root, reference);
            switch (action)
            {
                case "invoke": Pattern<InvokePattern>(element, InvokePattern.Pattern).Invoke(); break;
                case "set_value":
                    string value = request.GetProperty("text").GetString()!;
                    Require(value.Length <= 20000 && !value.Contains('\0'), "invalid_text", "Invalid text.");
                    var pattern = Pattern<ValuePattern>(element, ValuePattern.Pattern);
                    Require(!pattern.Current.IsReadOnly, "readonly_element", "This element is read-only.");
                    pattern.SetValue(value); break;
                case "select": Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern).Select(); break;
                case "toggle": Pattern<TogglePattern>(element, TogglePattern.Pattern).Toggle(); break;
                case "expand": Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern).Expand(); break;
                case "collapse": Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern).Collapse(); break;
                default: throw new ComputerException("unsupported_action", "Unsupported semantic action.");
            }
        }
        else
        {
            Require(mode == "foreground", "foreground_required", "Windows pointer and keyboard input require an explicitly approved foreground session.");
            if (action == "focus")
            {
                Require(Win32.SetForegroundWindow(window), "focus_failed", "Windows did not grant foreground focus. Bring the window forward locally.");
                Thread.Sleep(100);
                Require(Win32.GetForegroundWindow() == window, "focus_failed", "Window did not gain foreground focus.");
            }
            else if (action is "type" or "key")
            {
                CheckFocus(window, root, true);
                if (action == "key")
                {
                    var chord = Chord(request.GetProperty("keys").EnumerateArray().Select(x => x.GetString()!).ToArray());
                    Send([.. chord.Select(k => Key(k, false)), .. chord.Reverse().Select(k => Key(k, true))]);
                }
                else
                {
                    string value = request.GetProperty("text").GetString()!;
                    Require(value.Length <= 20000 && !value.Contains('\0'), "invalid_text", "Invalid text.");
                    var enumerator = StringInfo.GetTextElementEnumerator(value);
                    var batch = new List<Win32.Input>();
                    while (enumerator.MoveNext())
                    {
                        foreach (char c in enumerator.GetTextElement()) { batch.Add(Key(c, false, true)); batch.Add(Key(c, true, true)); }
                        if (batch.Count >= 128) { CheckSession(); FailSafe(); CheckFocus(window, root, true); Send(batch.ToArray()); batch.Clear(); }
                    }
                    if (batch.Count > 0) { CheckFocus(window, root, true); Send(batch.ToArray()); }
                }
            }
            else
            {
                CheckFocus(window, root, false);
                double x = Number(request, "x"), y = Number(request, "y");
                Require(target.Bounds.Contains(x, y), "outside_window", "Point is outside the approved window.");
                void HitTest(double px, double py)
                {
                    nint hit = Win32.GetAncestor(Win32.WindowFromPoint(new Win32.Point((int)Math.Floor(px), (int)Math.Floor(py))), 2);
                    Require(hit == window, "occluded_window", "Another window covers the input point. No input was sent.");
                    var element = AutomationElement.FromPoint(new UiaPoint(px, py));
                    Require(!element.Current.IsPassword, "protected_element", "Protected fields are not input targets.");
                }
                HitTest(x, y);
                string button = request.TryGetProperty("button", out var b) ? b.GetString()! : "left";
                Require(button is "left" or "right" or "middle", "invalid_button", "Invalid mouse button.");
                uint down = button == "right" ? 8u : button == "middle" ? 32u : 2u, up = down * 2;
                switch (action)
                {
                    case "move": Send([Mouse(0, x, y)]); break;
                    case "click": Send([Mouse(0, x, y), Mouse(down), Mouse(up)]); break;
                    case "double_click": Send([Mouse(0, x, y), Mouse(down), Mouse(up), Mouse(down), Mouse(up)]); break;
                    case "scroll":
                        int amount = Integer(request, "amount", 0, -30, 30);
                        Send([Mouse(0, x, y), Mouse(Boolean(request, "horizontal") ? 0x1000u : 0x0800u, data: amount * 120)]); break;
                    case "drag":
                        double tx = Number(request, "toX"), ty = Number(request, "toY");
                        Require(target.Bounds.Contains(tx, ty), "outside_window", "Drag destination is outside the approved window.");
                        var inputs = new List<Win32.Input> { Mouse(0, x, y), Mouse(down) };
                        for (int step = 1; step <= 12; step++)
                        {
                            double px = x + (tx - x) * step / 12, py = y + (ty - y) * step / 12;
                            HitTest(px, py); inputs.Add(Mouse(0, px, py));
                        }
                        inputs.Add(Mouse(up)); Send(inputs.ToArray()); break;
                    default: throw new ComputerException("unsupported_action", "Unsupported computer action.");
                }
            }
        }
        return new { protocol = 1, ok = true, action, delivery = mode, foregroundChanged = oldForeground != Win32.GetForegroundWindow(), verificationRequired = true };
    }
    internal object Run()
    {
        Require(Integer(request, "protocol", 0, 1, 1) == 1, "protocol_mismatch", "Expected native protocol 1.");
        string op = Text(request, "op", 32);
        if (op == "status") return new { protocol = 1, platform = "win32", backend = "UI Automation/Win32", permissions = new { sessionAvailable = SessionAvailable() },
            capabilities = new { windowCapture = "Windows.Graphics.Capture, with PrintWindow only when WGC is unsupported", accessibilityTree = true, semanticActions = true, unicodeInput = true, backgroundPixelInput = false, foregroundInput = true, lockedUse = false, clipboardModified = false, multipleDisplays = true, dpiAwareness = "PerMonitorV2" }, minimumOS = "Windows 10/11 on a supported .NET 10 OS release" };
        CheckSession();
        if (op == "windows") return new { protocol = 1, windows = Windows() };
        if (op == "describe") return new { protocol = 1, target = Describe(Handle(Text(request, "windowId", 128))) };
        var expected = request.GetProperty("target").Deserialize<Target>(JsonOptions) ?? throw new ComputerException("invalid_target", "Missing target identity.");
        var target = Verify(expected);
        if (op == "interact") return Interact(target);
        Require(op == "observe", "unknown_operation", "Unknown native operation.");
        var result = new Dictionary<string, object?> { ["protocol"] = 1, ["target"] = target, ["elements"] = Array.Empty<object>(), ["treeTruncated"] = false,
            ["frame"] = new { target.Bounds.X, target.Bounds.Y, target.Bounds.Width, target.Bounds.Height, imageWidth = 0, imageHeight = 0 } };
        if (Boolean(request, "includeImage", true))
        {
            var capture = Capture(target, Integer(request, "maxImageSide", 1800, 320, 2560));
            result["frame"] = capture.Frame; result["data"] = Convert.ToBase64String(capture.Data); result["mimeType"] = "image/jpeg";
            result["captureMethod"] = capture.Method; result["captureMayOmitGpuContent"] = capture.Method.StartsWith("PrintWindow", StringComparison.Ordinal);
        }
        if (Boolean(request, "includeTree", true))
        {
            var tree = Tree(AutomationElement.FromHandle(Handle(target.WindowId)), Integer(request, "maxNodes", 250, 1, 500), Integer(request, "maxDepth", 8, 1, 12));
            result["elements"] = tree.Elements; result["treeTruncated"] = tree.Truncated;
        }
        Require(Verify(target).Bounds.Matches(target.Bounds), "window_changed", "Window changed during observation; observe again.");
        return result;
    }
    internal static object SelfTest()
    {
        Require(Marshal.SizeOf<Win32.Input>() == (nint.Size == 8 ? 40 : 28), "self_test", "Incorrect SendInput ABI layout.");
        Require(Normalize(-1920, -1920, 3840) == 0 && Normalize(1919, -1920, 3840) == 65535, "self_test", "Negative-monitor geometry failed.");
        Require(Chord(["ctrl", "shift", "a"]).Length == 3 && Key(0xD83D, false, true).Data.Keyboard.Scan == 0xD83D, "self_test", "Keyboard encoding failed.");
        try { _ = Chord(["a", "b"]); throw new ComputerException("self_test", "Invalid chord accepted."); }
        catch (ComputerException error) when (error.Code == "invalid_keys") { }
        return new { protocol = 1, ok = true, selfTest = true };
    }
}

internal static class Entry
{
    [MTAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.SequenceEqual(new[] { "--self-test" })) { Console.Write(JsonSerializer.Serialize(WindowsComputer.SelfTest(), WindowsComputer.JsonOptions)); return 0; }
            WindowsComputer.Require(args.Length == 0, "invalid_request", "No command-line arguments are accepted.");
            _ = Win32.SetProcessDpiAwarenessContext(new nint(-4)); // Also declared in the executable manifest before managed code starts.
            using var input = Console.OpenStandardInput();
            using var buffer = new MemoryStream();
            byte[] chunk = new byte[8192];
            while (buffer.Length <= 131072)
            {
                int count = input.Read(chunk, 0, (int)Math.Min(chunk.Length, 131073 - buffer.Length));
                if (count == 0) break;
                buffer.Write(chunk, 0, count);
            }
            WindowsComputer.Require(buffer.Length <= 131072, "request_too_large", "Request exceeds 128 KiB.");
            using var request = JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 32 });
            WindowsComputer.Require(request.RootElement.ValueKind == JsonValueKind.Object, "invalid_request", "Expected a JSON object.");
            object result = new WindowsComputer(request.RootElement).Run();
            Console.Write(JsonSerializer.Serialize(result, WindowsComputer.JsonOptions));
            return 0;
        }
        catch (Exception error)
        {
            Console.Write(JsonSerializer.Serialize(new { protocol = 1, error = new { code = error is ComputerException native ? native.Code : "native_error", message = error.Message } }, WindowsComputer.JsonOptions));
            return 1;
        }
    }
}
