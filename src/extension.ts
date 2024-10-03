import { spawn } from "child_process";
import {
  commands,
  ExtensionContext,
  languages,
  Range,
  Uri,
  window,
  workspace,
} from "vscode";
import { DummyFS } from "./dummyFS";
import { GrepLine, Panel, Summary } from "./panel";

const RIPGREP_LANGID = "ripgrep-panel";
const DUMMY_FS_SCHEME = "rg-vscode-fake-fs";
const RG_BUFFER_NAME = "VSCode Ripgrep";
let rgBufferCounter = 0;

const grepPanel = new Panel();

interface EditorGroupSubLayout {
  groups?: EditorGroupSubLayout[];
  size: number;
}

interface EditorGroupLayout extends EditorGroupSubLayout {
  orientation: 0 | 1; // 0: LeftRight, 1: UpDown
}

function numGroups(layout: EditorGroupSubLayout): number {
  if (layout.groups === undefined) return 1;
  return layout.groups.reduce((s, l) => s + numGroups(l), 0);
}

interface GrepBegin {
  type: "begin";
  data: { path?: { text?: string } };
}
interface GrepEnd {
  type: "end";
  data: { path?: { text?: string } };
}
interface GrepMatch {
  type: "match";
  data: {
    path?: { text?: string };
    lines: { text?: string };
    line_number: number;
    submatches: { match: { text?: string }; start: number; end: number }[];
  };
}
interface GrepSummary {
  type: "summary";
  data: {
    elapsed_total: { human: string; secs: number; nanos: number };
    stats: { matched_lines: number };
  };
}

type GrepMessage = GrepBegin | GrepEnd | GrepMatch | GrepSummary;

function doQuery(query: string, queryId: number, cwd: string) {
  const rgProc = spawn("rg", ["--json", query], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd,
  });

  let stderrBuffer = "";
  rgProc.stderr.on("data", (data) => (stderrBuffer += data.toString()));

  rgProc.on("error", (e) => {
    grepPanel.onSummary(
      { type: "error", msg: `Process error ${e}.\n\nstderr:\n${stderrBuffer}` },
      queryId,
    );
  });

  grepPanel.manageProc(rgProc, queryId);
  const stream = rgProc.stdout;
  let buf = "";
  stream.on("data", (data) => {
    if (!grepPanel.isQueryId(queryId)) {
      // duplicate kill (`manageProc` should already kill it), but just in case
      rgProc.kill();
      return;
    }

    buf = buf + data.toString();
    const lines = buf.split("\n");
    if (lines.length > 0) {
      buf = lines.pop()!;
      let summary: Summary | undefined = undefined;
      let gls: GrepLine[] = [];
      for (const line of lines) {
        const msg: GrepMessage = JSON.parse(line);
        if (msg.type === "match") {
          const data = msg.data;
          const text = data.lines.text;
          if (text !== undefined && text.endsWith("\n")) {
            gls.push({
              file: data.path?.text ?? "<bad filename>",
              lineNo: data.line_number,
              line: text.trimEnd(),
              match: data.submatches.map(({ start, end }) => ({ start, end })),
            });
          }
        } else if (msg.type === "summary") {
          const data = msg.data;
          const elapsed =
            (data.elapsed_total.secs + data.elapsed_total.nanos * 1e-9).toFixed(2) + "s";
          summary = { type: "done", matches: data.stats.matched_lines, elapsed };
        }
      }
      grepPanel.onGrepLines(gls, queryId);
      if (summary !== undefined) grepPanel.onSummary(summary, queryId);
    }
  });
}

async function onEdit() {
  const onEdit = await grepPanel.onEdit();
  if (onEdit === undefined) return;
  const { query, queryId, cwd } = onEdit;
  // TODO refactor [doQuery] to a callback
  doQuery(query, queryId, cwd);
}

async function toggleDir() {
  const onToggle = await grepPanel.toggleDir();
  if (onToggle === undefined) return;
  const { query, queryId, cwd } = onToggle;
  // TODO refactor [doQuery] to a callback
  doQuery(query, queryId, cwd);
}

async function find() {
  const reqSrcEditor = window.activeTextEditor;
  if (reqSrcEditor === undefined) return;

  const reqDoc = reqSrcEditor.document;
  const reqViewColumn = reqSrcEditor.viewColumn;
  const sel = reqSrcEditor.selection;
  const initQuery = reqDoc.getText(new Range(sel.start, sel.end));

  const file = Uri.from({
    scheme: DUMMY_FS_SCHEME,
    path: `/${RG_BUFFER_NAME}          ${rgBufferCounter++}`,
    query: initQuery,
  });
  workspace.fs.writeFile(file, new Uint8Array());
  const doc = await workspace.openTextDocument(file);
  languages.setTextDocumentLanguage(doc, RIPGREP_LANGID);

  const editorGroupLayout: EditorGroupLayout = await commands.executeCommand(
    "vscode.getEditorLayout",
  );

  if (editorGroupLayout.orientation == 1) {
    if (editorGroupLayout.groups === undefined) {
      throw "Unexpected editor layout (groups is undefined)";
    }
    // updown, add another one in the bottom
    let restHeight = 0;
    for (const sub of editorGroupLayout.groups) {
      const newSize = Math.floor((sub.size * 2) / 3);
      restHeight += sub.size - newSize;
      sub.size = newSize;
    }
    editorGroupLayout.groups.push({ size: restHeight });
  } else {
    // leftright, add into the bottom
    // TODO better way to infer the size of the editor
    editorGroupLayout.orientation = 1;
    editorGroupLayout.groups = [
      { groups: editorGroupLayout.groups, size: 660 },
      { size: 340 },
    ];
  }

  await commands.executeCommand("vscode.setEditorLayout", editorGroupLayout);

  const docLine0End = doc.lineAt(0).range.end;
  const rgPanelEditor = await window.showTextDocument(doc, {
    viewColumn: numGroups(editorGroupLayout),
    selection: new Range(docLine0End, docLine0End),
  });
  try {
    // try to turn vim into insert mode
    await commands.executeCommand("vim.remap", { after: "A" });
  } catch {}

  grepPanel.init(rgPanelEditor, reqViewColumn, reqDoc);
  await onEdit();
}

export async function activate(context: ExtensionContext) {
  workspace.registerFileSystemProvider(DUMMY_FS_SCHEME, new DummyFS(), {
    isReadonly: false,
  });
  workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId == RIPGREP_LANGID) {
      setTimeout(onEdit, 200);
    }
  });
  context.subscriptions.push(
    commands.registerCommand("ripgrep.enter", async () => grepPanel.enter()),
    commands.registerCommand("ripgrep.quit", async () => grepPanel.quit(true)),
    commands.registerCommand("ripgrep.find", find),
    commands.registerCommand("ripgrep.moveFocus", (args) => grepPanel.moveFocus(args)),
    commands.registerCommand("ripgrep.toggleSearchDir", () => toggleDir()),
  );
}

export function deactivate() {}
