using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace CodexLink.Computer;

// Windows Graphics Capture is used for modern GPU-rendered windows. No monitor
// capture, hidden border, permission request, desktop switch or unlock is performed.
internal static class WindowsCapture
{
    [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(nint window, in Guid iid, out nint result);
        [PreserveSig] int CreateForMonitor(nint monitor, in Guid iid, out nint result);
    }
    [DllImport("combase.dll")] private static extern int RoInitialize(uint mode);
    [DllImport("combase.dll")] private static extern void RoUninitialize();
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string source, uint length, out nint value);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(nint value);
    [DllImport("combase.dll")] private static extern int RoGetActivationFactory(nint name, in Guid iid, out nint factory);
    [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(nint adapter, uint type, nint software, uint flags, nint levels, uint levelCount, uint sdkVersion, out nint device, out uint level, out nint context);
    [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgi, out nint device);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int WindowFrame(nint window, uint attribute, out Win32.Rect value, int size);

    internal static bool Supported => GraphicsCaptureSession.IsSupported();
    private static void Check(int result) => Marshal.ThrowExceptionForHR(result);
    private static GraphicsCaptureItem Item(nint window)
    {
        const string name = "Windows.Graphics.Capture.GraphicsCaptureItem";
        nint hstring = 0, factoryPointer = 0, itemPointer = 0;
        object? factoryObject = null;
        try
        {
            Check(WindowsCreateString(name, (uint)name.Length, out hstring));
            Guid factoryId = typeof(IGraphicsCaptureItemInterop).GUID;
            Check(RoGetActivationFactory(hstring, in factoryId, out factoryPointer));
            factoryObject = Marshal.GetObjectForIUnknown(factoryPointer);
            var factory = (IGraphicsCaptureItemInterop)factoryObject;
            // Request the public IInspectable ABI, then let C#/WinRT project the runtime class.
            Guid inspectable = new("af86e2e0-b12d-4c6a-9c5a-d7aa65101e90");
            Check(factory.CreateForWindow(window, in inspectable, out itemPointer));
            return WinRT.MarshalInspectable<GraphicsCaptureItem>.FromAbi(itemPointer);
        }
        finally
        {
            if (itemPointer != 0) Marshal.Release(itemPointer);
            if (factoryObject is not null && Marshal.IsComObject(factoryObject)) Marshal.ReleaseComObject(factoryObject);
            if (factoryPointer != 0) Marshal.Release(factoryPointer);
            if (hstring != 0) _ = WindowsDeleteString(hstring);
        }
    }
    private static IDirect3DDevice Device()
    {
        nint d3d = 0, context = 0, dxgi = 0, inspectable = 0;
        try
        {
            int result = D3D11CreateDevice(0, 1, 0, 0x20, 0, 0, 7, out d3d, out _, out context);
            if (result < 0)
            {
                if (context != 0) { Marshal.Release(context); context = 0; }
                if (d3d != 0) { Marshal.Release(d3d); d3d = 0; }
                // Software rendering is a graphics fallback, not a permissions fallback.
                result = D3D11CreateDevice(0, 5, 0, 0x20, 0, 0, 7, out d3d, out _, out context);
            }
            Check(result);
            Guid dxgiId = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Check(Marshal.QueryInterface(d3d, in dxgiId, out dxgi));
            Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
            return WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        }
        finally
        {
            if (inspectable != 0) Marshal.Release(inspectable);
            if (dxgi != 0) Marshal.Release(dxgi);
            if (context != 0) Marshal.Release(context);
            if (d3d != 0) Marshal.Release(d3d);
        }
    }
    internal static (Bitmap Image, Bounds Bounds) Capture(Target target)
    {
        int apartment = RoInitialize(1); Check(apartment);
        try { return CaptureAsync(target).GetAwaiter().GetResult(); }
        catch (COMException error) when (error.HResult == unchecked((int)0x80070005))
        {
            throw new ComputerException("capture_permission", "Windows denied capture of this application. No alternate capture path or permission bypass was attempted.");
        }
        finally { RoUninitialize(); }
    }
    private static async Task<(Bitmap Image, Bounds Bounds)> CaptureAsync(Target target)
    {
        nint window = (nint)long.Parse(target.WindowId, System.Globalization.CultureInfo.InvariantCulture);
        WindowsComputer.Require(Supported, "wgc_unsupported", "Windows Graphics Capture is not supported in this environment.");
        var item = Item(window);
        Check(WindowFrame(window, 9, out var r, Marshal.SizeOf<Win32.Rect>()));
        var bounds = new Bounds(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        WindowsComputer.Require(bounds.Width > 0 && bounds.Height > 0 && (long)item.Size.Width * item.Size.Height <= 40_000_000, "capture_too_large", "Invalid or excessive capture dimensions.");
        WindowsComputer.Require(item.Size.Width == (int)bounds.Width && item.Size.Height == (int)bounds.Height, "capture_geometry", "Capture and native window geometry disagree. Observe again after the window finishes resizing.");
        using var device = Device();
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false; // Only excludes the cursor from the image.
        var available = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Arrived(Direct3D11CaptureFramePool sender, object args)
        {
            try { var next = sender.TryGetNextFrame(); if (next is not null && !available.TrySetResult(next)) next.Dispose(); }
            catch (Exception error) { available.TrySetException(error); }
        }
        pool.FrameArrived += Arrived;
        try
        {
            session.StartCapture(); // Leave the operating system's visible capture indicator enabled.
            using var frame = await available.Task.WaitAsync(TimeSpan.FromSeconds(4)).ConfigureAwait(false);
            WindowsComputer.Require(frame.ContentSize.Width == item.Size.Width && frame.ContentSize.Height == item.Size.Height, "capture_geometry", "Window resized while capturing; observe again.");
            using var copied = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
            using var pixels = SoftwareBitmap.Convert(copied, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            int width = pixels.PixelWidth, height = pixels.PixelHeight;
            WindowsComputer.Require(width == item.Size.Width && height == item.Size.Height, "capture_geometry", "Unexpected capture surface dimensions.");
            byte[] bytes = new byte[checked(width * height * 4)];
            var buffer = new Windows.Storage.Streams.Buffer((uint)bytes.Length);
            buffer.Length = (uint)bytes.Length;
            pixels.CopyToBuffer(buffer);
            using (var reader = DataReader.FromBuffer(buffer)) reader.ReadBytes(bytes);
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            try
            {
                var data = bitmap.LockBits(new System.Drawing.Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
                try { for (int y = 0; y < height; y++) Marshal.Copy(bytes, y * width * 4, data.Scan0 + y * data.Stride, width * 4); }
                finally { bitmap.UnlockBits(data); }
                return (bitmap, bounds);
            }
            catch { bitmap.Dispose(); throw; }
        }
        finally
        {
            pool.FrameArrived -= Arrived;
            if (!available.Task.IsCompleted) available.TrySetCanceled();
        }
    }
}
