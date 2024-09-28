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
import { DummyFS } from "./DummyFS";

const RIPGREP_LANGID = "ripgrep-panel";
const DUMMY_FS_SCHEME = "rg-vscode-fake-fs";
const RG_BUFFER_PATH = "/VSCode Ripgrep";

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

let globalEditor: TextEditor | undefined;
let globalQuery = "";

function onkey(key: string) {
  if (globalEditor === undefined) return;
  const line0End = globalEditor.document.lineAt(0).range.end;
  globalEditor.edit((eb) => {
    eb.insert(line0End, key);
  });
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
  data: { elapsed_total: { human: string }; stats: { matched_lines: number } };
}

type GrepMessage = GrepBegin | GrepEnd | GrepMatch | GrepSummary;

function doQuery(query: string) {
  if (globalEditor === undefined) return;
  const doc = globalEditor.document;
  const rgProc = spawn("C:\\Apps\\ripgrep\\rg.exe", ["--json", query], {
    stdio: ["ignore", "pipe", "ignore"],
    cwd: "C:\\Users\\Jimmy\\source\\repos\\vscode-ripgrep",
  });
  const stream = rgProc.stdout;
  let buf = "";
  stream.on("data", (data) => {
    if (globalEditor === undefined || globalQuery !== query) {
      if (!rgProc.killed) rgProc.kill();
      return;
    }
    buf = buf + data.toString();
    const lastNewLine = buf.lastIndexOf("\n");
    if (lastNewLine > 0) {
      const lines = buf.substring(0, lastNewLine).split("\n");
      buf = buf.substring(lastNewLine + 1);

      let toAdd = "";
      let endData: GrepSummary["data"] | undefined;
      for (const line of lines) {
        const msg: GrepMessage = JSON.parse(line);
        if (msg.type === "match") {
          const data = msg.data;
          const text = data.lines.text;
          if (text !== undefined && text.endsWith("\n")) {
            toAdd += `\n${data.path?.text}:${data.line_number}: ${text.trim()}`;
          }
        } else if (msg.type === "summary") {
          endData = msg.data;
        }
      }

      globalEditor.edit((eb) => {
        const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
        eb.replace(docEnd, toAdd);
        if (endData) {
          eb.replace(
            doc.lineAt(1).range,
            `Done: ${endData.stats.matched_lines} lines  ${endData.elapsed_total.human}`
          );
        }
      });
    }
  });
}

async function onEdit() {
  if (globalEditor === undefined) return;
  const doc = globalEditor.document;
  const query = doc.getText(doc.lineAt(0).range).replace(/^rg> /, "");
  if (globalQuery === query) return;
  globalQuery = query;
  if (query === "") return;
  await globalEditor.edit((eb) => {
    const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
    const line1ToEnd = new Range(new Position(1, 0), docEnd);
    eb.replace(line1ToEnd, `processing query [${globalQuery}]`);
  });
  doQuery(globalQuery);
}

async function find() {
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

  globalEditor = await window.showTextDocument(doc, {
    viewColumn: numGroups(editorGroupLayout),
    selection: new Range(0, 3, 0, 3),
  });
  await commands.executeCommand("vim.remap", { after: "A" });
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
  context.subscriptions.push(commands.registerCommand("ripgrep.find", find));
  context.subscriptions.push(commands.registerCommand("ripgrep.onkey", onkey));
}

export function deactivate() {}
