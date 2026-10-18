using System; using System.IO; using System.Runtime.InteropServices; using System.Windows.Forms; using System.Drawing;
[ComImport, Guid("00000122-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDT {
  [PreserveSig] int DragEnter(IntPtr d, int k, long pt, ref int e);
  [PreserveSig] int DragOver(int k, long pt, ref int e);
  [PreserveSig] int DragLeave();
  [PreserveSig] int Drop(IntPtr d, int k, long pt, ref int e);
}
public class Tgt : IDT {
  public string Name; public int Eff; public static string Log;
  public Tgt(string n,int eff){Name=n;Eff=eff;}
  void W(string s){File.AppendAllText(Log, Name+" "+s+"\r\n");}
  public int DragEnter(IntPtr d,int k,long pt,ref int e){W("enter");e=Eff;return 0;}
  public int DragOver(int k,long pt,ref int e){e=Eff;return 0;}
  public int DragLeave(){W("leave");return 0;}
  public int Drop(IntPtr d,int k,long pt,ref int e){W("drop");e=Eff;return 0;}
}
public static class N {
  [DllImport("ole32.dll")] public static extern int OleInitialize(IntPtr p);
  [DllImport("ole32.dll")] public static extern int RegisterDragDrop(IntPtr h, IDT t);
  [DllImport("ole32.dll")] public static extern int RevokeDragDrop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h,int i,int v);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);
}
