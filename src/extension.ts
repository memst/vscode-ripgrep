import {
  CancellationToken,
  commands,
  DocumentSymbol,
  DocumentSymbolProvider,
  ExtensionContext,
  languages,
  Position,
  ProviderResult,
  Range,
  SymbolInformation,
  SymbolKind,
  TextDocument,
  Uri,
  window,
  workspace,
} from "vscode";
import { DummyFS } from "./dummyFS";
import { Panel } from "./panel";

const RIPGREP_LANGID = "ripgrep-panel";
const DUMMY_FS_SCHEME = "rg-vscode-fake-fs";
const RG_BUFFER_NAME = "VSCode Ripgrep";
let rgBufferCounter = 0;

export const grepPanel = new Panel();

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
    await commands.executeCommand("vim.remap", { after: ["A"] });
  } catch {}

  grepPanel.init(rgPanelEditor, reqViewColumn, reqDoc);
  await grepPanel.onEdit();
}

export async function activate(context: ExtensionContext) {
  workspace.registerFileSystemProvider(DUMMY_FS_SCHEME, new DummyFS(), {
    isReadonly: false,
  });
  workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId == RIPGREP_LANGID) {
      setTimeout(() => grepPanel.onEdit(), 200);
    }
  });
  workspace.onDidCloseTextDocument((doc) => {
    grepPanel.onDocumentClosed(doc);
  });
  window.onDidChangeActiveTextEditor((_te) => {
    grepPanel.quit(false);
  });
  window.onDidChangeTextEditorSelection((e) => {
    grepPanel.onChangeSelection(e);
  });
  context.subscriptions.push(
    commands.registerCommand("ripgrep.enter", async () => grepPanel.enter()),
    commands.registerCommand("ripgrep.quit", async () => grepPanel.quit(true)),
    commands.registerCommand("ripgrep.find", find),
    commands.registerCommand("ripgrep.moveFocus", (args) => grepPanel.moveFocus(args)),
    commands.registerCommand("ripgrep.toggleSearchDir", () => grepPanel.toggleDir()),
  );
  languages.registerDocumentSymbolProvider(
    { language: "ripgrep-panel" },
    new (class implements DocumentSymbolProvider {
      provideDocumentSymbols(
        doc: TextDocument,
        _token: CancellationToken,
      ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (doc.lineCount >= 2) {
          const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
          const ds1 = new DocumentSymbol(
            "rgpanel-query",
            "",
            SymbolKind.Module,
            new Range(new Position(0, 0), docEnd),
            doc.lineAt(0).range,
          );

          const ds2 = new DocumentSymbol(
            "rgpanel-result",
            "",
            SymbolKind.Module,
            new Range(new Position(1, 0), docEnd),
            doc.lineAt(1).range,
          );
          ds1.children = [ds2];
          return [ds1];
        }
        return [];
      }
    })(),
  );
}

export function deactivate() {}
