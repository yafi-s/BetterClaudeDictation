// VoiceKit: the native half of BetterClaudeDiction.
//
// - Opens the microphone through WinMM (waveIn) as 24 kHz, 16-bit, mono PCM,
//   the format OpenAI's realtime transcription takes, in tens of milliseconds
//   (ffmpeg's DirectShow path needs ~800 ms, which loses the first words).
// - Watches one global push-to-talk key with GetAsyncKeyState (no hook, no
//   key logging: it reports only that key's down/up, whether another key was
//   pressed while it was held, and Escape presses).
//
// Protocol
//   stdin lines : start | stop | quit        (EOF also quits)
//   stdout      : frames  [1 byte type][4 byte LE length][payload]
//                 type 1 = PCM16LE audio, type 2 = UTF-8 JSON event
//   args        : --hotkey <vk hex|0> --device <name substring> --list-devices
//
// Built with the .NET Framework compiler that ships with Windows (C# 5):
//   csc /nologo /optimize+ /platform:x64 /target:exe /out:voicekit.exe VoiceKit.cs

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class VoiceKit
{
    // ---- WinMM -------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WAVEINCAPS
    {
        public ushort wMid;
        public ushort wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint dwFormats;
        public ushort wChannels;
        public ushort wReserved1;
    }

    [DllImport("winmm.dll")]
    static extern uint waveInGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "waveInGetDevCapsW")]
    static extern uint waveInGetDevCaps(UIntPtr uDeviceID, ref WAVEINCAPS pwic, uint cbwic);

    [DllImport("winmm.dll")]
    static extern uint waveInOpen(out IntPtr phwi, uint uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, uint fdwOpen);

    [DllImport("winmm.dll")]
    static extern uint waveInPrepareHeader(IntPtr hwi, IntPtr pwh, uint cbwh);

    [DllImport("winmm.dll")]
    static extern uint waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, uint cbwh);

    [DllImport("winmm.dll")]
    static extern uint waveInAddBuffer(IntPtr hwi, IntPtr pwh, uint cbwh);

    [DllImport("winmm.dll")]
    static extern uint waveInStart(IntPtr hwi);

    [DllImport("winmm.dll")]
    static extern uint waveInReset(IntPtr hwi);

    [DllImport("winmm.dll")]
    static extern uint waveInClose(IntPtr hwi);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    const uint WAVE_MAPPER = 0xFFFFFFFF;
    const uint WAVE_MAPPED = 0x0004;
    const uint CALLBACK_EVENT = 0x00050000;
    const uint WHDR_DONE = 0x00000001;

    const int SAMPLE_RATE = 24000;
    const int BUFFER_MS = 20;
    const int BUFFER_COUNT = 12;
    const int BUFFER_BYTES = SAMPLE_RATE * 2 * BUFFER_MS / 1000; // 960

    // ---- output ------------------------------------------------------------

    static readonly object OutLock = new object();
    static Stream Out;

    static void WriteFrame(byte type, byte[] payload, int count)
    {
        lock (OutLock)
        {
            try
            {
                byte[] head = new byte[5];
                head[0] = type;
                head[1] = (byte)(count & 0xFF);
                head[2] = (byte)((count >> 8) & 0xFF);
                head[3] = (byte)((count >> 16) & 0xFF);
                head[4] = (byte)((count >> 24) & 0xFF);
                Out.Write(head, 0, 5);
                if (count > 0) Out.Write(payload, 0, count);
                Out.Flush();
            }
            catch (IOException)
            {
                Environment.Exit(0); // the parent went away
            }
        }
    }

    static void Emit(string json)
    {
        byte[] b = Encoding.UTF8.GetBytes(json);
        WriteFrame(2, b, b.Length);
    }

    static string Q(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
            else if (c < 0x20) { sb.Append("\\u").Append(((int)c).ToString("x4")); }
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // ---- devices -----------------------------------------------------------

    static List<string> DeviceNames()
    {
        List<string> names = new List<string>();
        uint n = waveInGetNumDevs();
        for (uint i = 0; i < n; i++)
        {
            WAVEINCAPS caps = new WAVEINCAPS();
            uint r = waveInGetDevCaps(new UIntPtr(i), ref caps, (uint)Marshal.SizeOf(typeof(WAVEINCAPS)));
            names.Add(r == 0 ? caps.szPname : "");
        }
        return names;
    }

    // ---- capture -----------------------------------------------------------

    static string DeviceFilter = "";
    static readonly object CmdLock = new object();
    static readonly Queue<string> Commands = new Queue<string>();
    static readonly AutoResetEvent CmdSignal = new AutoResetEvent(false);
    // Each start gets a sequence number; a stop covers every start before it,
    // so a stop that arrives before its capture opened still ends it.
    static int StartSeq;
    static volatile int StopSeq;

    static void Command(string c)
    {
        lock (CmdLock)
        {
            if (c == "start") { StartSeq++; Commands.Enqueue("start:" + StartSeq); }
            else if (c == "stop" || c == "quit") { StopSeq = StartSeq; Commands.Enqueue(c); }
            else Commands.Enqueue(c);
        }
        CmdSignal.Set();
    }

    static string NextCommand()
    {
        lock (CmdLock) return Commands.Count > 0 ? Commands.Dequeue() : null;
    }

    static void AudioWorker()
    {
        while (true)
        {
            CmdSignal.WaitOne(250);
            string c;
            while ((c = NextCommand()) != null)
            {
                if (c == "quit") { Environment.Exit(0); }
                if (c.StartsWith("start:"))
                {
                    int seq = int.Parse(c.Substring(6));
                    Capture(seq); // always opens, so every start answers started + stopped
                }
            }
        }
    }

    static void Capture(int seq)
    {
        long t0 = DateTime.UtcNow.Ticks;
        uint device = WAVE_MAPPER;
        string deviceName = "Windows default microphone";
        if (DeviceFilter.Length > 0)
        {
            List<string> names = DeviceNames();
            for (int i = 0; i < names.Count; i++)
            {
                if (names[i].IndexOf(DeviceFilter, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    device = (uint)i;
                    deviceName = names[i];
                    break;
                }
            }
            if (device == WAVE_MAPPER)
            {
                Emit("{\"type\":\"warning\",\"message\":" + Q("No microphone matches '" + DeviceFilter + "'; using the Windows default.") + "}");
            }
        }

        WAVEFORMATEX fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1;
        fmt.nChannels = 1;
        fmt.nSamplesPerSec = SAMPLE_RATE;
        fmt.wBitsPerSample = 16;
        fmt.nBlockAlign = 2;
        fmt.nAvgBytesPerSec = SAMPLE_RATE * 2;
        fmt.cbSize = 0;

        AutoResetEvent ready = new AutoResetEvent(false);
        IntPtr hwi;
        uint flags = CALLBACK_EVENT | (device == WAVE_MAPPER ? 0u : WAVE_MAPPED);
        uint r = waveInOpen(out hwi, device, ref fmt, ready.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, flags);
        if (r != 0)
        {
            Emit("{\"type\":\"capture\",\"state\":\"error\",\"code\":" + r + ",\"message\":" + Q("waveInOpen failed (MMRESULT " + r + "). Is a microphone connected and allowed in Windows privacy settings?") + "}");
            Emit("{\"type\":\"capture\",\"state\":\"stopped\"}");
            return;
        }

        int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
        int flagsOffset = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwFlags");
        int recordedOffset = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwBytesRecorded");
        IntPtr[] hdrs = new IntPtr[BUFFER_COUNT];
        IntPtr[] datas = new IntPtr[BUFFER_COUNT];
        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            datas[i] = Marshal.AllocHGlobal(BUFFER_BYTES);
            hdrs[i] = Marshal.AllocHGlobal(hdrSize);
            WAVEHDR h = new WAVEHDR();
            h.lpData = datas[i];
            h.dwBufferLength = BUFFER_BYTES;
            Marshal.StructureToPtr(h, hdrs[i], false);
            waveInPrepareHeader(hwi, hdrs[i], (uint)hdrSize);
            waveInAddBuffer(hwi, hdrs[i], (uint)hdrSize);
        }
        waveInStart(hwi);
        double openMs = (DateTime.UtcNow.Ticks - t0) / 10000.0;
        Emit("{\"type\":\"capture\",\"state\":\"started\",\"device\":" + Q(deviceName) + ",\"openMs\":" + openMs.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "}");

        byte[] chunk = new byte[BUFFER_BYTES];
        int next = 0;
        bool reset = false;
        while (true)
        {
            ready.WaitOne(50);
            if (StopSeq >= seq && !reset)
            {
                waveInReset(hwi); // returns every queued buffer, partial ones included
                reset = true;
            }
            int drained = 0;
            while (drained < BUFFER_COUNT)
            {
                uint f = (uint)Marshal.ReadInt32(hdrs[next], flagsOffset);
                if ((f & WHDR_DONE) == 0) break;
                int n = Marshal.ReadInt32(hdrs[next], recordedOffset);
                if (n > 0)
                {
                    Marshal.Copy(datas[next], chunk, 0, n);
                    WriteFrame(1, chunk, n);
                }
                if (!reset)
                {
                    Marshal.WriteInt32(hdrs[next], flagsOffset, (int)(f & ~WHDR_DONE));
                    Marshal.WriteInt32(hdrs[next], recordedOffset, 0);
                    waveInAddBuffer(hwi, hdrs[next], (uint)hdrSize);
                }
                else
                {
                    Marshal.WriteInt32(hdrs[next], flagsOffset, (int)(f & ~WHDR_DONE));
                }
                next = (next + 1) % BUFFER_COUNT;
                drained++;
            }
            if (reset)
            {
                // After waveInReset every buffer is done; one pass drained them in order.
                break;
            }
        }

        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            waveInUnprepareHeader(hwi, hdrs[i], (uint)hdrSize);
        }
        waveInClose(hwi);
        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            Marshal.FreeHGlobal(hdrs[i]);
            Marshal.FreeHGlobal(datas[i]);
        }
        ready.Close();
        Emit("{\"type\":\"capture\",\"state\":\"stopped\"}");
    }

    // ---- hotkey ------------------------------------------------------------

    static bool Down(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    static void KeyWorker(int vk)
    {
        HashSet<int> ignore = new HashSet<int>();
        ignore.Add(vk);
        ignore.Add(0xE7); // VK_PACKET
        ignore.Add(0xFF);
        if (vk == 0xA2 || vk == 0xA3) ignore.Add(0x11);            // ctrl
        if (vk == 0xA4 || vk == 0xA5) { ignore.Add(0x12); }          // alt
        if (vk == 0xA5) { ignore.Add(0xA2); ignore.Add(0x11); }      // AltGr sends a fake left ctrl
        if (vk == 0xA0 || vk == 0xA1) ignore.Add(0x10);            // shift

        bool held = false;
        bool chorded = false;
        bool escHeld = false;
        bool[] before = new bool[256];
        while (true)
        {
            bool isDown = Down(vk);
            if (isDown && !held)
            {
                held = true;
                chorded = false;
                for (int k = 1; k < 255; k++) before[k] = !ignore.Contains(k) && Down(k);
                Emit("{\"type\":\"key\",\"state\":\"down\"}");
            }
            else if (!isDown && held)
            {
                held = false;
                Emit("{\"type\":\"key\",\"state\":\"up\"}");
            }
            else if (isDown && !chorded)
            {
                for (int k = 1; k < 255; k++)
                {
                    if (ignore.Contains(k) || before[k]) continue;
                    if (Down(k))
                    {
                        chorded = true;
                        Emit("{\"type\":\"key\",\"state\":\"chord\"}");
                        break;
                    }
                }
            }
            bool esc = Down(0x1B);
            if (esc && !escHeld) Emit("{\"type\":\"key\",\"state\":\"escape\"}");
            escHeld = esc;
            Thread.Sleep(held ? 8 : 12);
        }
    }

    // ---- main --------------------------------------------------------------

    static int Main(string[] args)
    {
        int hotkey = 0;
        bool list = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--hotkey" && i + 1 < args.Length)
            {
                string v = args[++i];
                hotkey = v.StartsWith("0x") ? Convert.ToInt32(v.Substring(2), 16) : int.Parse(v);
            }
            else if (args[i] == "--device" && i + 1 < args.Length) DeviceFilter = args[++i].Trim();
            else if (args[i] == "--list-devices") list = true;
        }

        if (list)
        {
            List<string> names = DeviceNames();
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < names.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(Q(names[i]));
            }
            Console.Out.WriteLine(sb.Append(']').ToString());
            return 0;
        }

        Out = Console.OpenStandardOutput();
        Thread audio = new Thread(AudioWorker);
        audio.IsBackground = true;
        audio.Priority = ThreadPriority.AboveNormal;
        audio.Start();
        if (hotkey > 0)
        {
            Thread keys = new Thread(delegate () { KeyWorker(hotkey); });
            keys.IsBackground = true;
            keys.Start();
        }
        Emit("{\"type\":\"ready\",\"hotkey\":" + hotkey + "}");

        TextReader input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        string line;
        while ((line = input.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            Command(line);
            if (line == "quit") break;
        }
        Command("stop");
        Command("quit");
        Thread.Sleep(300);
        return 0;
    }
}
