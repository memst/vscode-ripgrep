import { spawn } from "child_process";
import { grepPanel } from "./extension";
import { GrepLine, Summary } from "./panel";
import path from "path";

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

interface RipGrepQuery {
  query: string;
  cwd: string;
  dir: string[];
  case: "smart" | "strict" | "ignore"; // --ignore-case --smart-case
  regex: "on" | "off"; // --fixed-strings
  word: "on" | "off"; // --word-regexp
}

export function doQuery(q: RipGrepQuery, queryId: number) {
  const rgOpts = ["--json"];
  if (q.case === "smart") {
    rgOpts.push("--smart-case");
  } else if (q.case === "ignore") {
    rgOpts.push("--ignore-case");
  }
  if (q.regex === "off") rgOpts.push("--fixed-strings");
  if (q.word === "on") rgOpts.push("--word-regexp");

  // resolve to relative dir
  let dirs = q.dir.map((dir) => {
    const rel = path.relative(q.cwd, dir);
    return rel || ".";
  });
  if (dirs.length === 1 && dirs[0] === ".") {
    dirs = [];
  }

  const rgProc = spawn("rg", [q.query, ...dirs, ...rgOpts], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: q.cwd,
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
