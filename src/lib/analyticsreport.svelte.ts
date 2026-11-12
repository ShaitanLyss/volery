/* Writing a report (§13): a save dialog and one narrow command.
 *
 * The bytes are `analyticsreport.ts`'s renderer; nothing here decides what a
 * report is. The dialog picks the path, the command insists on `.html`, and the
 * extension is made rather than corrected where a person typed it without one —
 * the file rules' standing choice, since silently renaming what somebody typed
 * is a file saved where they cannot find it.
 */

import { invoke } from "@tauri-apps/api/core";
import { reportFile, reportName, type ReportModel } from "./analyticsreport";

/** The path it was written to, or `""` when the dialog was dismissed. */
export async function writeReportFile(model: ReportModel, title: string): Promise<string> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({
    title: "Export a report",
    defaultPath: reportName(title, Date.now()),
    filters: [{ name: "report", extensions: ["html"] }],
  });
  if (typeof picked !== "string") return "";
  const path = picked.toLowerCase().endsWith(".html") ? picked : `${picked}.html`;
  await invoke("write_report", { path, html: reportFile(model) });
  return path;
}
