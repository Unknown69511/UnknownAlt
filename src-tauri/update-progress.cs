using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("UnknownALT Update")]
[assembly: AssemblyProduct("UnknownALT")]
[assembly: AssemblyCompany("Unknown69511")]

public sealed class UnknownAltUpdateWindow : Form
{
    const int InstallerProgressMessage = 0x8144;
    static readonly Color Fill = Color.White;
    static readonly Color Track = Color.FromArgb(43, 39, 36);
    readonly string statePath;
    readonly PictureBox logo;
    readonly Label status;
    readonly Label heading;
    readonly ProgressTrack progress;
    readonly Timer timer;
    readonly Stopwatch elapsed = Stopwatch.StartNew();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4096 };
    long nextPoll, missingSince = -1, installCurrent, installTotal;
    double displayed, target;
    bool permitClose, determinate;
    string phase = "preparing";
    ProgressState last;

    public sealed class ProgressState
    {
        public string phase { get; set; }
        public long current { get; set; }
        public long total { get; set; }
        public int ownerPid { get; set; }
        public string ownerStart { get; set; }
    }

    UnknownAltUpdateWindow(string stage)
    {
        string name = Path.GetFileName(stage);
        Guid token;
        const string prefix = "unknownalt-update-";
        if (name == null || !name.StartsWith(prefix, StringComparison.Ordinal)
            || !Guid.TryParseExact(name.Substring(prefix.Length), "D", out token))
            throw new ArgumentException("Invalid update staging folder.");
        statePath = Path.Combine(stage, "update-progress.json");
        last = ReadState();
        if (last == null || !IsAlive(last))
            throw new InvalidOperationException("The update has no active writer.");

        Text = "UnknownALT Update - " + token.ToString("D");
        AccessibleName = "UnknownALT Update";
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = true;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        MaximizeBox = false;
        MinimizeBox = false;
        ControlBox = false;
        ClientSize = new Size(420, 276);
        BackColor = Color.FromArgb(17, 16, 16);
        ForeColor = Color.FromArgb(243, 237, 232);
        Font = new Font("Segoe UI", 10F);
        DoubleBuffered = true;
        logo = new PictureBox { Location = new Point(164, 30), Size = new Size(92, 92), SizeMode = PictureBoxSizeMode.Zoom, AccessibleName = "UnknownALT mascot" };
        using (var mascot = Assembly.GetExecutingAssembly().GetManifestResourceStream("UnknownALT.Mascot"))
        using (var image = Image.FromStream(mascot))
            logo.Image = new Bitmap(image);
        heading = new Label {
            Text = "Updating UnknownALT", Location = new Point(24, 140), Size = new Size(372, 34),
            TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI Semibold", 16F)
        };
        status = new Label {
            Text = "Preparing update...", Location = new Point(24, 180), Size = new Size(372, 26),
            TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.FromArgb(201, 190, 182)
        };
        progress = new ProgressTrack(this) { Location = new Point(32, 225), Size = new Size(356, 8) };
        Controls.AddRange(new Control[] { logo, heading, status, progress });

        timer = new Timer { Interval = 30 };
        timer.Tick += Tick;
        Shown += delegate { Activate(); timer.Start(); };
        FormClosed += delegate { timer.Dispose(); logo.Image.Dispose(); Icon.Dispose(); heading.Font.Dispose(); Font.Dispose(); };
    }

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length != 1) return 1;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try {
            using (var window = new UnknownAltUpdateWindow(args[0]))
                Application.Run(window);
            return 0;
        } catch (ArgumentException error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        } catch (InvalidOperationException error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    ProgressState ReadState()
    {
        try {
            using (var file = new FileStream(statePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                if (file.Length == 0 || file.Length > 4096) return null;
                using (var text = new StreamReader(file)) return json.Deserialize<ProgressState>(text.ReadToEnd());
            }
        } catch (IOException) { return null; }
          catch (ArgumentException) { return null; }
          catch (InvalidOperationException) { return null; }
          catch (UnauthorizedAccessException) { return null; }
    }

    static bool IsAlive(ProgressState state)
    {
        if (state.ownerPid <= 0 || String.IsNullOrEmpty(state.ownerStart)) return false;
        try {
            using (var owner = Process.GetProcessById(state.ownerPid))
                return !owner.HasExited && owner.StartTime.ToFileTimeUtc().ToString() == state.ownerStart;
        } catch (ArgumentException) { return false; }
          catch (InvalidOperationException) { return false; }
          catch (System.ComponentModel.Win32Exception) { return false; }
    }

    void Tick(object sender, EventArgs e)
    {
        long now = elapsed.ElapsedMilliseconds;
        if (now >= nextPoll) {
            nextPoll = now + 120;
            last = ReadState() ?? last;
            if (last.phase == "completed") { CloseFromTransaction(); return; }
            if (last.phase == "failed" || last.phase == "rolled-back" || last.phase == "recovery-needed") { ShowRecovery(last.phase); return; }
            if (!IsAlive(last)) {
                if (missingSince < 0) missingSince = now;
                if (now - missingSince > 2000) { ShowRecovery("interrupted"); return; }
            } else missingSince = -1;
            if (phase != last.phase) {
                phase = last.phase;
                displayed = 0;
            }
            UpdateDisplay();
        }
        // Ease toward actual progress. The fill never runs ahead of the reported value.
        displayed += (target - displayed) * 0.24;
        if (Math.Abs(target - displayed) < 0.001) displayed = target;
        progress.Invalidate();
    }

    void CloseFromTransaction()
    {
        permitClose = true;
        Close();
    }

    void ShowRecovery(string outcome)
    {
        if (permitClose) return;
        permitClose = true;
        timer.Stop();
        progress.Hide();
        heading.Text = "Update couldn't finish";
        status.Size = new Size(372, 68);
        status.Text = outcome == "rolled-back"
            ? "The previous version and saved data were restored. Reopen UnknownALT and retry from Updates."
            : outcome == "recovery-needed" || outcome == "interrupted"
                ? "Reopen UnknownALT to recover the update. If recovery is still pending, restart Windows. Keep your backups."
                : "Open UnknownALT and check Updates for details. You can retry the update from there.";
        ClientSize = new Size(420, 315);
        var close = new Button { Text = "Close", Size = new Size(96, 32), Location = new Point(162, 267), FlatStyle = FlatStyle.Flat, BackColor = Track };
        close.Click += delegate { CloseFromTransaction(); };
        Controls.Add(close);
        close.Select();
    }

    void UpdateDisplay()
    {
        string label;
        long current = 0, total = 0;
        switch (phase) {
            case "downloading": label = "Downloading update"; current = last.current; total = last.total; break;
            case "verifying": label = "Verifying the download"; current = last.current; total = last.total; break;
            case "backing-up":
                label = last.current > 0 ? String.Format("Backing up your data · {0:N0} files saved", last.current) : "Backing up your data...";
                break;
            case "closing": label = "Closing UnknownALT safely..."; break;
            case "installing": label = "Installing update"; current = installCurrent; total = installTotal; break;
            case "restarting": label = "Reopening UnknownALT..."; break;
            case "restoring": label = "Restoring the previous version..."; break;
            default: label = "Preparing update..."; break;
        }
        determinate = total > 0 && current >= 0 && current <= total;
        target = determinate ? (double)current / total : 0;
        if (determinate) label += "  " + (int)((decimal)current * 100 / total) + "%";
        else if (phase == "installing" || phase == "downloading" || phase == "verifying") label += "...";
        if (status.Text != label) status.Text = label;
    }

    protected override void WndProc(ref Message message)
    {
        const int WmClose = 0x0010;
        if (message.Msg == WmClose && !permitClose) return;
        if (message.Msg == 0x8145) { ShowRecovery("failed"); return; }
        if (message.Msg == InstallerProgressMessage) {
            long current = message.WParam.ToInt64(), total = message.LParam.ToInt64();
            if (total > 0 && total <= Int32.MaxValue && current >= 0 && current <= total
                && (total != installTotal || current >= installCurrent)) {
                installCurrent = current;
                installTotal = total;
                if (phase == "installing") UpdateDisplay();
            }
            return;
        }
        base.WndProc(ref message);
    }

    sealed class ProgressTrack : Control
    {
        readonly UnknownAltUpdateWindow owner;
        public ProgressTrack(UnknownAltUpdateWindow window)
        {
            owner = window;
            AccessibleName = "Update progress";
            AccessibleRole = AccessibleRole.ProgressBar;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            int width = ClientSize.Width, height = ClientSize.Height;
            if (height < 2 || width <= height) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath shape = Rounded(width, height))
            using (var background = new SolidBrush(Track))
            using (var fill = new SolidBrush(Fill)) {
                e.Graphics.FillPath(background, shape);
                e.Graphics.SetClip(shape);
                if (owner.determinate) {
                    e.Graphics.FillRectangle(fill, 0F, 0F, (float)(width * owner.displayed), height);
                } else {
                    float stripe = width * 0.24F;
                    float offset = (width + stripe) * (owner.elapsed.ElapsedMilliseconds % 1600) / 1600F - stripe;
                    e.Graphics.FillRectangle(fill, offset, 0F, stripe, height);
                }
            }
        }

        static GraphicsPath Rounded(int width, int height)
        {
            var shape = new GraphicsPath();
            shape.AddArc(0, 0, height, height, 90, 180);
            shape.AddArc(width - height, 0, height, height, 270, 180);
            shape.CloseFigure();
            return shape;
        }
    }
}
