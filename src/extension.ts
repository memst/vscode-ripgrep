import { spawn } from "child_process";
import {
  commands,
  ExtensionContext,
  languages,
  Position,
  Range,
  TextEditor,
  Uri,
  window,
  workspace,
} from "vscode";
import { DummyFS } from "./dummyFS";
import { GrepLine, Panel, Summary } from "./panel";

const RIPGREP_LANGID = "ripgrep-panel";
const DUMMY_FS_SCHEME = "rg-vscode-fake-fs";
const RG_BUFFER_PATH = "/VSCode Ripgrep";

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

function doQuery(query: string, queryId: number) {
  const rgProc = spawn("C:\\Apps\\ripgrep\\rg.exe", ["--json", query], {
    stdio: ["ignore", "pipe", "ignore"],
    cwd: "C:\\Users\\Jimmy\\source\\repos\\vscode-ripgrep",
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
  const onEdit = grepPanel.onEdit();
  if (onEdit === undefined) return;
  const { query, queryId } = onEdit;
  doQuery(query, queryId);
}

async function find() {
  const reqSrcEditor = window.activeTextEditor;
  if (reqSrcEditor === undefined) return;

  const file = Uri.from({ scheme: DUMMY_FS_SCHEME, path: RG_BUFFER_PATH });
  workspace.fs.writeFile(file, new Uint8Array());
  const doc = await workspace.openTextDocument(file);
  languages.setTextDocumentLanguage(doc, RIPGREP_LANGID);

  const editorGroupLayout: EditorGroupLayout = await commands.executeCommand(
    "vscode.getEditorLayout"
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

  const rgPanelEditor = await window.showTextDocument(doc, {
    viewColumn: numGroups(editorGroupLayout),
    selection: new Range(0, 4, 0, 4),
  });
  await commands.executeCommand("vim.remap", { after: "A" });

  grepPanel.init(rgPanelEditor, reqSrcEditor);
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
  context.subscriptions.push(commands.registerCommand("ripgrep.nop", () => {}));
  context.subscriptions.push(commands.registerCommand("ripgrep.find", find));
  context.subscriptions.push(
    commands.registerCommand("ripgrep.moveFocus", (args) => grepPanel.moveFocus(args))
  );
}

export function deactivate() {}
