import * as vscode from "vscode";
import { RunQuerySuccess } from "../runner";

let panel: vscode.WebviewPanel | undefined;

export function showResults(context: vscode.ExtensionContext, result: RunQuerySuccess, sql: string): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "informixQueryResults",
      "Informix Query Results",
      vscode.ViewColumn.Beside,
      {
        enableScripts: false,
        retainContextWhenHidden: true
      }
    );

    panel.onDidDispose(() => {
      panel = undefined;
    });
  }

  panel.title = "Informix Query Results";
  panel.webview.html = buildHtml(result, sql);
  panel.reveal(vscode.ViewColumn.Beside, true);
}

function buildHtml(result: RunQuerySuccess, sql: string): string {
  const escapedSql = escapeHtml(sql);
  const headCells = result.columns.map((col: string) => `<th>${escapeHtml(col)}</th>`).join("");

  const bodyRows = result.rows
    .map((row: Array<unknown>) => {
      const cells = row.map((value: unknown) => `<td>${escapeHtml(formatCell(value))}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const tableHtml = result.columns.length === 0
    ? "<p>No columns returned.</p>"
    : `<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: sans-serif; margin: 16px; color: #1f2937; }
    .meta { margin-bottom: 12px; font-size: 12px; color: #374151; }
    .sql { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 10px; border-radius: 6px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #e5e7eb; text-align: left; padding: 6px 8px; vertical-align: top; }
    th { background: #f9fafb; position: sticky; top: 0; }
    tbody tr:nth-child(even) { background: #fcfcfd; }
  </style>
</head>
<body>
  <div class="meta">row_count=${result.row_count} | elapsed_ms=${result.elapsed_ms} | truncated=${result.truncated ? "yes" : "no"}</div>
  <div class="sql">${escapedSql}</div>
  <h3>Results</h3>
  ${tableHtml}
</body>
</html>`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
