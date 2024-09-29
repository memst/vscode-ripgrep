import {
  DecorationOptions,
  DecorationRenderOptions,
  Position,
  Range,
  TextEditor,
  TextEditorRevealType,
  ThemeColor,
  Uri,
  window,
} from "vscode";
import { throttle } from "./throttle";
import { ChildProcess } from "child_process";
import path from "path";

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
  | {
      type: "start";
      query: string;
    };

const MAX_LINES_TO_SHOW = 200;

const focusDecoration = window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new ThemeColor("peekViewEditor.matchHighlightBackground"),
});
const matchDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("errorForeground"),
  fontWeight: "bold",
});
const matchFilenameDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("terminal.ansiBrightBlue"),
});
const matchLineDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("terminal.ansiBrightGreen"),
});

export class Panel {
  private queryId = -1;
  private curQuery = "";
  private curModes = undefined;
  private proc: ChildProcess | undefined;

  private refreshResults = false;
  private pendingEdits: PendingEdit[] = [];
  private pendingSummary: Summary | undefined;
  private applyEdits: () => void;

  private rgPanelEditor: TextEditor | undefined;
  private reqSrcEditor: TextEditor | undefined;

  private matchLineInfos: MatchLine[] = [];
  private matchDecorationRegions: Range[] = [];

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
      await this.rgPanelEditor.edit((eb) => {
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
              `Done: ${s.matches} matches found in ${s.elapsed}`
            );
          } else if (s.type === "start") {
            eb.replace(doc.lineAt(1).range, `Processing query [${s.query}]`);
          }
        }
      });
      this.rgPanelEditor?.setDecorations(matchDecoration, this.matchDecorationRegions);
      if (this.currentFocus === undefined) this.setFocus(0);
    }, 200);
  }

  public init(rgPanelEditor: TextEditor, reqSrcEditor: TextEditor) {
    this.rgPanelEditor = rgPanelEditor;
    this.reqSrcEditor = reqSrcEditor;
  }

  public quit() {
    this.rgPanelEditor = undefined;
    this.reqSrcEditor = undefined;
    this.proc?.kill();
  }

  public isQueryId(queryId: number) {
    return this.queryId === queryId;
  }

  /** returns new query id or undefined if not changed */
  public onEdit() {
    if (this.rgPanelEditor === undefined) return undefined;
    const doc = this.rgPanelEditor.document;
    const query = doc.getText(doc.lineAt(0).range).replace(/^rg> /, "");
    if (query === this.curQuery || query === "") {
      return undefined;
    } else {
      return { query, queryId: this.newQuery(query, undefined) };
    }
  }

  private newQuery(query: string, modes?: {}): number {
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
    this.pendingSummary = { type: "start", query };

    // TODO high
    //   await globalEditor.edit((eb) => {
    //     const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
    //     const line1ToEnd = new Range(new Position(1, 0), docEnd);
    //     eb.replace(line1ToEnd, `processing query [${globalQuery}]`);
    //   });

    // TODO erase decorations
    this.currentFocus = undefined;
    this.rgPanelEditor?.setDecorations(focusDecoration, []);

    return this.queryId;
  }

  public manageProc(proc: ChildProcess, queryId: number) {
    if (queryId === this.queryId) {
      this.proc = proc;
    } else {
      proc.kill();
    }
  }

  public moveFocus(dir: "up" | "down") {
    if (this.matchLineInfos.length === 0) return;
    let focus = this.currentFocus ?? 0;
    if (dir === "up") {
      focus = Math.max(0, focus - 1);
    } else if (dir === "down") {
      focus = Math.min(this.matchLineInfos.length - 1, focus + 1);
    }
    this.setFocus(focus);
  }

  private setFocus(to: number) {
    this.currentFocus = to;

    if (this.rgPanelEditor !== undefined) {
      const line = to + 2;
      this.rgPanelEditor.setDecorations(focusDecoration, [
        this.rgPanelEditor.document.lineAt(line).range,
      ]);
      this.rgPanelEditor.revealRange(new Range(line - 1, 0, line + 1, 0));

      const info = this.matchLineInfos[to];
      const f = info.file;
      const l = info.lineNo;
      if (info !== undefined && f !== undefined && l !== undefined) {
        (async function () {
          // TODO viewColumn
          const file = Uri.file(
            path.join("C:\\Users\\Jimmy\\source\\repos\\vscode-ripgrep", f)
          );
          const editor = await window.showTextDocument(file, {
            viewColumn: 1,
            preserveFocus: true,
            preview: true,
          });
          const lineL = editor.document.lineAt(l - 1).range;
          editor.setDecorations(focusDecoration, [lineL]);
          editor.revealRange(lineL, TextEditorRevealType.InCenter);
        })();
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
        this.matchDecorationRegions.push(
          new Range(nextLine, linePreLen + start, nextLine, linePreLen + end)
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
