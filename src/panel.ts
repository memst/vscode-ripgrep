import assert from "assert";
import { ChildProcess } from "child_process";
import path from "path";
import {
  commands,
  Position,
  Range,
  Selection,
  TextEditor,
  TextEditorRevealType,
  ThemeColor,
  Uri,
  window,
  workspace,
} from "vscode";
import { throttle } from "./throttle";

export interface GrepLine {
  file: string;
  lineNo: number;
  line: string;
  match: { start: number; end: number }[];
}

interface MatchLine {
  file?: string;
  lineNo?: number;
}

interface PendingEdit {
  line: string;
}

export type Summary =
  | {
      type: "done";
      elapsed: string;
      matches: number;
    }
  | { type: "error"; msg: string }
  | {
      type: "start";
      query: string;
    };

interface Mode {
  cwd: string;
  docDir: string | undefined;
  workspaceDir: string | undefined;
  /** doc/ws dir can only be changed if cwd is not edited manually */
  docOrWorkspaceDir: "doc" | "workspace" | "neither";
}

const MAX_LINES_TO_SHOW = 200;

const focusDecoration = window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new ThemeColor("list.activeSelectionBackground"),
});
const matchDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("errorForeground"),
  fontWeight: "bold",
});
const filenameDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("terminal.ansiBrightBlue"),
});
const linenumberDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("terminal.ansiBrightGreen"),
});

export class Panel {
  private queryId = -1;
  private curQuery = "";
  private curMode: Mode | undefined;
  private proc: ChildProcess | undefined;

  private refreshResults = false;
  private pendingEdits: PendingEdit[] = [];
  private pendingSummary: Summary | undefined;
  private applyEdits: () => void;

  private rgPanelEditor: TextEditor | undefined;
  private reqViewColumn: number | undefined;

  private matchLineInfos: MatchLine[] = [];
  private matchDecorationRegions: Range[] = [];
  private filenameDecorationRegions: Range[] = [];
  private linenumberDecorationRegions: Range[] = [];

  /** index in the arrays, line number = index + 2 */
  private currentFocus: number | undefined = undefined;

  constructor() {
    this.applyEdits = throttle(async () => {
      if (this.rgPanelEditor === undefined) return;
      if (
        this.pendingEdits.length === 0 &&
        this.pendingSummary === undefined &&
        !this.refreshResults
      )
        return;
      const edits = this.pendingEdits;
      const toAdd = edits.map((pe) => pe.line).join("");
      this.pendingEdits = [];
      await this.rgPanelEditor.edit(
        (eb) => {
          if (this.rgPanelEditor === undefined) return;
          const doc = this.rgPanelEditor.document;
          const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
          if (this.refreshResults) {
            this.refreshResults = false;
            eb.replace(new Range(doc.lineAt(1).range.end, docEnd), toAdd);
          } else {
            eb.insert(docEnd, toAdd);
          }
          if (this.pendingSummary) {
            const s = this.pendingSummary;
            this.pendingSummary = undefined;
            if (s.type === "done") {
              eb.replace(
                doc.lineAt(1).range,
                `Done: ${s.matches} matches in [${this.curMode?.cwd}] (${s.elapsed})`,
              );
            } else if (s.type === "start") {
              eb.replace(doc.lineAt(1).range, `Processing query [${s.query}]`);
            } else if (s.type === "error") {
              eb.replace(doc.lineAt(1).range, `ERROR: ${s.msg}`);
            }
          }
        },
        { undoStopAfter: false, undoStopBefore: false },
      );

      this.rgPanelEditor?.setDecorations(matchDecoration, this.matchDecorationRegions);
      this.rgPanelEditor?.setDecorations(
        filenameDecoration,
        this.filenameDecorationRegions,
      );
      this.rgPanelEditor?.setDecorations(
        linenumberDecoration,
        this.linenumberDecorationRegions,
      );

      if (this.currentFocus === undefined) {
        await this.setFocus(0);
      }
    }, 200);
  }

  public init(rgPanelEditor: TextEditor, reqSrcEditor: TextEditor | undefined) {
    this.rgPanelEditor = rgPanelEditor;
    this.reqViewColumn = reqSrcEditor?.viewColumn;
    this.curQuery = "";
    const workspaceDir = workspace.workspaceFolders?.[0].uri.path;
    let docDir = undefined;
    if (reqSrcEditor !== undefined) {
      const doc = reqSrcEditor.document;
      if (doc.uri.scheme === "file") {
        docDir = path.dirname(doc.uri.path);
      }
    }
    const cwdPath = docDir ?? workspaceDir;
    const cwd =
      cwdPath === undefined
        ? undefined
        : Uri.from({ scheme: "file", path: cwdPath }).fsPath;
    if (cwd === undefined) {
      const msg = "Unable to get cwd: both workspace and current folder are undefined";
      window.showErrorMessage(msg);
      throw msg;
    }
    const docOrWorkspaceDir = docDir !== undefined ? "doc" : "workspace";
    this.curMode = {
      cwd,
      docDir,
      workspaceDir,
      docOrWorkspaceDir,
    };
  }

  public async quit(backToStart: boolean) {
    this.proc?.kill();
    if (this.rgPanelEditor !== undefined) {
      const doc = this.rgPanelEditor.document;
      const viewColumn = this.rgPanelEditor.viewColumn;
      await window.showTextDocument(doc, { preserveFocus: false, viewColumn });
      await commands.executeCommand("workbench.action.files.saveWithoutFormatting");
      await commands.executeCommand("workbench.action.closeEditorsAndGroup");

      // try to remove decorations on the preview editor
      const editor = window.activeTextEditor;
      if (editor !== undefined) {
        editor.setDecorations(focusDecoration, []);
      }
      if (backToStart) {
        // TODO try to revert preview panel state to the previous file
      }
    }
    this.rgPanelEditor = undefined;
  }

  public isQueryId(queryId: number) {
    return this.queryId === queryId;
  }

  /** returns new query id or undefined if not changed */
  public async onEdit() {
    if (this.rgPanelEditor === undefined) return undefined;
    const doc = this.rgPanelEditor.document;
    const query = doc.getText(doc.lineAt(0).range).replace(/^rg> /, "");
    if (query === this.curQuery || query === "") {
      return undefined;
    } else {
      assert(this.curMode !== undefined, "unexpected undefined mode");
      const queryId = await this.newQuery(query);
      return { query, queryId, cwd: this.curMode.cwd };
    }
  }

  /** returns new query id or undefined if not changed */
  public async toggleDir() {
    if (this.rgPanelEditor === undefined) return undefined;
    assert(this.curMode !== undefined, "unexpected undefined mode");
    const mode = this.curMode;
    if (mode.docOrWorkspaceDir === "doc" && mode.workspaceDir !== undefined) {
      mode.docOrWorkspaceDir = "workspace";
      mode.cwd = Uri.from({ scheme: "file", path: mode.workspaceDir }).fsPath;
    } else if (mode.docOrWorkspaceDir === "workspace" && mode.docDir !== undefined) {
      mode.docOrWorkspaceDir = "doc";
      mode.cwd = Uri.from({ scheme: "file", path: mode.docDir }).fsPath;
    } else {
      // not changed
      return undefined;
    }
    const query = this.curQuery;
    const queryId = await this.newQuery(query);
    return { query, queryId, cwd: mode.cwd };
  }

  // TODO support mode change
  private async newQuery(query: string): Promise<number> {
    this.queryId++;
    // TODO this.curModes=modes;
    this.curQuery = query;
    this.proc?.kill();
    this.proc = undefined;

    // erase all edits and decorations
    this.refreshResults = true;
    this.pendingEdits = [];
    this.matchLineInfos = [];
    this.matchDecorationRegions = [];
    this.filenameDecorationRegions = [];
    this.linenumberDecorationRegions = [];
    this.pendingSummary = { type: "start", query };

    if (this.rgPanelEditor !== undefined) {
      const doc = this.rgPanelEditor.document;
      await this.rgPanelEditor.edit((eb) => {
        const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
        const line1ToEnd = new Range(new Position(1, 0), docEnd);
        eb.replace(line1ToEnd, `processing query [${query}] in [${this.curMode?.cwd}]`);
      });
    }

    this.currentFocus = undefined;
    this.rgPanelEditor?.setDecorations(focusDecoration, []);
    this.rgPanelEditor?.setDecorations(matchDecoration, []);
    // TODO remove filename and line number decorations

    return this.queryId;
  }

  public manageProc(proc: ChildProcess, queryId: number) {
    if (queryId === this.queryId) {
      this.proc = proc;
    } else {
      proc.kill();
    }
  }

  public async enter() {
    await this.quit(false);
    if (this.currentFocus === undefined) return;
    const info = this.matchLineInfos[this.currentFocus];
    const f = info.file;
    const l = info.lineNo;
    if (info !== undefined && f !== undefined && l !== undefined) {
      const viewColumn = this.reqViewColumn ?? 1;
      const file = Uri.file(path.join(this.curMode!.cwd, f));
      const doc = await workspace.openTextDocument(file);
      const lineL = doc.lineAt(l - 1).range;
      const editor = await window.showTextDocument(doc, {
        viewColumn,
        preserveFocus: false,
        preview: false,
      });
      try {
        await commands.executeCommand("vim.remap", { after: ["<Esc>"] });
      } catch {}
      editor.selections = [new Selection(lineL.start, lineL.start)];
      editor.setDecorations(focusDecoration, []);
      editor.revealRange(lineL, TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  public moveFocus(dir: string) {
    if (this.matchLineInfos.length === 0) return;
    let focus = this.currentFocus ?? 0;
    switch (dir) {
      case "up":
        focus = Math.max(0, focus - 1);
        break;
      case "up5":
        focus = Math.max(0, focus - 5);
        break;
      case "down":
        focus = Math.min(this.matchLineInfos.length - 1, focus + 1);
        break;
      case "down5":
        focus = Math.min(this.matchLineInfos.length - 1, focus + 5);
        break;
      default:
        window.showErrorMessage(`Unknown move direction "${dir}"`);
    }
    this.setFocus(focus);
  }

  private async setFocus(to: number) {
    if (this.matchLineInfos[to] === undefined) return;
    this.currentFocus = to;

    if (this.rgPanelEditor !== undefined) {
      const line = to + 2;
      this.rgPanelEditor.setDecorations(focusDecoration, [new Range(line, 0, line, 0)]);
      this.rgPanelEditor.revealRange(new Range(line - 1, 0, line + 1, 0));

      const info = this.matchLineInfos[to];
      const f = info.file;
      const l = info.lineNo;
      if (info !== undefined && f !== undefined && l !== undefined) {
        const viewColumn = this.reqViewColumn ?? 1;
        const file = Uri.file(path.join(this.curMode!.cwd, f));
        const editor = await window.showTextDocument(file, {
          viewColumn,
          preserveFocus: true,
          preview: true,
        });
        const lineL = editor.document.lineAt(l - 1).range;
        editor.setDecorations(focusDecoration, [lineL]);
        editor.revealRange(lineL, TextEditorRevealType.InCenter);
      }
    }
  }

  public onGrepLines(gls: GrepLine[], queryId: number) {
    if (queryId !== this.queryId) return;

    let nextLine = this.matchLineInfos.length + 2;
    for (const gl of gls) {
      if (nextLine >= MAX_LINES_TO_SHOW) {
        if (nextLine == MAX_LINES_TO_SHOW) {
          // show max lines message
          this.pendingEdits.push({ line: "\n...more results omitted" });
          this.matchLineInfos.push({});
        }
        nextLine++;
        break;
      }
      const linePre = `${gl.file}:${gl.lineNo}:`;
      const linePreLen = linePre.length;
      this.pendingEdits.push({ line: `\n${linePre}${gl.line}` });
      this.matchLineInfos.push({ file: gl.file, lineNo: gl.lineNo });
      for (const { start, end } of gl.match) {
        this.filenameDecorationRegions.push(
          new Range(nextLine, 0, nextLine, gl.file.length),
        );
        this.linenumberDecorationRegions.push(
          new Range(
            nextLine,
            gl.file.length + 1,
            nextLine,
            gl.file.length + 1 + gl.lineNo.toString().length,
          ),
        );
        this.matchDecorationRegions.push(
          new Range(nextLine, linePreLen + start, nextLine, linePreLen + end),
        );
      }
      nextLine++;
    }
    this.applyEdits();
  }

  public onSummary(summary: Summary, queryId: number) {
    if (queryId !== this.queryId) return;
    this.pendingSummary = summary;
    this.applyEdits();
  }
}
