// A drop target that writes down everything a drag offered: every format on
// the data object at DragEnter, and at Drop what each one holds. The sink for
// browsers.ps1, which drags an image, a link and a file out of a real browser
// into it. Formats are read through the raw COM IDataObject so FileContents can
// be asked for at lindex 0, which is how Chromium serves a virtual file.
using System; using System.IO; using System.Text; using System.Windows.Forms; using System.Drawing;
using System.Runtime.InteropServices; using CT = System.Runtime.InteropServices.ComTypes;
public class Sink : Form {
  public static string Log;
  static void W(string s){ File.AppendAllText(Log, s + "\r\n"); }
  public Sink(){
    Text = "BROWSINK"; AllowDrop = true; TopMost = true; BackColor = Color.DarkSlateGray;
    StartPosition = FormStartPosition.Manual;
    DragEnter += (s, e) => { W("enter formats: " + string.Join(" | ", e.Data.GetFormats(false))); e.Effect = DragDropEffects.Copy & e.AllowedEffect; if (e.Effect == 0) e.Effect = e.AllowedEffect; };
    DragOver += (s, e) => { e.Effect = DragDropEffects.Copy & e.AllowedEffect; if (e.Effect == 0) e.Effect = e.AllowedEffect; };
    DragDrop += (s, e) => { W("allowed effect: " + e.AllowedEffect); foreach (var f in e.Data.GetFormats(false)) W(Describe(e.Data, f)); W("DROPPED"); };
  }
  static string Describe(IDataObject d, string f){
    try {
      if (f == "FileContents") return f + ": " + Contents(d);
      object o = d.GetData(f, false);
      if (o == null) return f + ": null";
      if (o is string) { var s = (string)o; return f + ": string " + s.Length + " " + Clip(s); }
      if (o is string[]) return f + ": string[] " + string.Join(" ; ", (string[])o);
      if (o is MemoryStream) {
        var b = ((MemoryStream)o).ToArray();
        if (f == "FileGroupDescriptorW") return f + ": " + Fgd(b);
        if (f.StartsWith("UniformResourceLocatorW") || f == "text/x-moz-url" || f == "text/uri-list" || f.Contains("FileNameW"))
          return f + ": bytes " + b.Length + " " + Clip(Encoding.Unicode.GetString(b).TrimEnd('\0'));
        return f + ": bytes " + b.Length + " " + Clip(Encoding.UTF8.GetString(b, 0, Math.Min(b.Length, 200)).TrimEnd('\0'));
      }
      if (o is Bitmap) return f + ": bitmap " + ((Bitmap)o).Width + "x" + ((Bitmap)o).Height;
      return f + ": " + o.GetType().Name;
    } catch (Exception x) { return f + ": threw " + x.GetType().Name + " " + x.Message; }
  }
  static string Clip(string s){ s = s.Replace("\r", "\\r").Replace("\n", "\\n"); return s.Length > 240 ? s.Substring(0, 240) + "…" : s; }
  // FILEGROUPDESCRIPTORW: a count, then 592-byte FILEDESCRIPTORW each, the name
  // at offset 72 as 260 UTF-16 chars, the size at 64 (high) and 68 (low).
  static string Fgd(byte[] b){
    int n = BitConverter.ToInt32(b, 0); var sb = new StringBuilder("count " + n);
    for (int i = 0; i < n; i++) {
      int at = 4 + i * 592; uint flags = BitConverter.ToUInt32(b, at);
      long size = ((long)BitConverter.ToUInt32(b, at + 64) << 32) | BitConverter.ToUInt32(b, at + 68);
      string name = Encoding.Unicode.GetString(b, at + 72, 520).Split('\0')[0];
      sb.Append(" [" + name + " size=" + size + " flags=0x" + flags.ToString("x") + "]");
    }
    return sb.ToString();
  }
  static string Contents(IDataObject d){
    var com = d as CT.IDataObject; if (com == null) return "no COM IDataObject";
    short cf = (short)DataFormats.GetFormat("FileContents").Id; var sb = new StringBuilder();
    for (int i = 0; i < 4; i++) {
      var fe = new CT.FORMATETC { cfFormat = cf, dwAspect = CT.DVASPECT.DVASPECT_CONTENT, lindex = i, tymed = CT.TYMED.TYMED_ISTREAM | CT.TYMED.TYMED_HGLOBAL };
      CT.STGMEDIUM m;
      try { com.GetData(ref fe, out m); } catch (Exception x) { if (i == 0) sb.Append("lindex0 threw " + x.Message); break; }
      long len = 0; string head = "";
      if (m.tymed == CT.TYMED.TYMED_ISTREAM) {
        var st = (CT.IStream)Marshal.GetObjectForIUnknown(m.unionmember); var buf = new byte[65536]; IntPtr pn = Marshal.AllocHGlobal(4);
        var first = new byte[0];
        while (true) { st.Read(buf, buf.Length, pn); int got = Marshal.ReadInt32(pn); if (got <= 0) break; if (len == 0) { first = new byte[Math.Min(got, 8)]; Array.Copy(buf, first, first.Length); } len += got; }
        Marshal.FreeHGlobal(pn); head = BitConverter.ToString(first);
      } else if (m.tymed == CT.TYMED.TYMED_HGLOBAL) { len = (long)GlobalSize(m.unionmember); }
      sb.Append(" [lindex " + i + " " + m.tymed + " " + len + " bytes head " + head + "]");
    }
    return sb.ToString();
  }
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
