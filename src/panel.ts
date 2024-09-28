interface GrepLine {
  file: string;
  lineNo: string;
  line: string;
  match: { start: number; end: number }[];
}

export class Panel {
  reqSeq = -1;

  constructor() {}

  public onGrepLine(gl: GrepLine, reqSeq: number): "kill" | "ok" {
    if (reqSeq !== this.reqSeq) return "kill";

    // edit line to editor
    // wait for other edits to be done, optionally push to a queue

    return "ok";
  }
}
