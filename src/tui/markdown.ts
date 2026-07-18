// Markdown stream renderer. Accepts text deltas and emits ANSI-formatted
// lines. Stateful — buffers incomplete lines across delta calls.

import { bold, dim, italic, underline, blue, cyan, bgGray } from "./ansi.js";

type BlockType = "code" | "none";

interface State {
  block: BlockType;
  codeLang: string;
  codeBuffer: string[];
  lineBuffer: string;
  listBullet: string | null;
}

function freshState(): State {
  return {
    block: "none",
    codeLang: "",
    codeBuffer: [],
    lineBuffer: "",
    listBullet: null,
  };
}

export class MarkdownRenderer {
  private state = freshState();

  reset(): void {
    this.state = freshState();
  }

  push(delta: string): string {
    this.state.lineBuffer += delta;
    const lines = this.state.lineBuffer.split("\n");
    this.state.lineBuffer = lines.pop() ?? "";

    const out: string[] = [];
    for (const line of lines) {
      out.push(this.processLine(line));
    }
    return out.join("\n");
  }

  flush(): string {
    if (this.state.lineBuffer.length > 0) {
      const line = this.processLine(this.state.lineBuffer);
      this.state.lineBuffer = "";
      if (this.state.block === "code" && this.state.codeBuffer.length > 0) {
        const rendered = this.renderCodeBlock();
        return `${line}\n${rendered}`;
      }
      return line;
    }
    if (this.state.block === "code" && this.state.codeBuffer.length > 0) {
      return this.renderCodeBlock();
    }
    return "";
  }

  private processLine(line: string): string {
    const s = this.state;

    if (s.block === "code") {
      if (/^```$/.test(line.trim())) {
        const rendered = this.renderCodeBlock();
        s.block = "none";
        s.codeLang = "";
        return rendered;
      }
      s.codeBuffer.push(line);
      return dim(line);
    }

    if (/^```(\S*)$/.exec(line.trim())) {
      s.block = "code";
      s.codeLang = (/^```(\S*)$/.exec(line.trim())?.[1] ?? "").trim();
      s.codeBuffer = [];
      return "";
    }

    const heading = /^(#{1,4})\s+(.+)/.exec(line);
    if (heading && heading[1] && heading[2]) {
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1)
        return `${bold(underline(text))}\n${dim("─".repeat(Math.min(text.length, 60)))}`;
      if (level === 2) return `\n${bold(text)}`;
      return bold(text);
    }

    const listItem = /^(\s*)[-*]\s+(.+)/.exec(line);
    if (listItem) {
      const bullet = listItem[1] ? "  ◦" : "•";
      return `  ${dim(bullet)} ${listItem[2]}`;
    }

    const blockquote = /^>\s?(.*)/.exec(line);
    if (blockquote) {
      return `${dim("│")} ${italic(blockquote[1] ?? "")}`;
    }

    const hr = /^(---|\*\*\*)$/.exec(line.trim());
    if (hr) {
      return dim("─".repeat(60));
    }

    if (line.trim().length === 0) {
      s.listBullet = null;
      return "";
    }

    return renderInline(line);
  }

  private renderCodeBlock(): string {
    const lines = this.state.codeBuffer;
    this.state.codeBuffer = [];
    if (lines.length === 0) return "";
    const lang = this.state.codeLang;
    const label = lang ? ` ${lang} ` : "";
    const maxNum = String(lines.length).length;
    const numbered = lines.map(
      (l, i) =>
        ` ${dim(blue(String(i + 1).padStart(maxNum, " ")))} ${bgGray(` ${l}${" ".repeat(Math.max(0, 80 - l.length))}`)}`,
    );
    return [
      dim(cyan(`┌─${label}${"─".repeat(Math.max(0, 78 - label.length))}`)),
      ...numbered,
      dim(cyan(`└${"─".repeat(78)}`)),
    ].join("\n");
  }
}

function renderInline(line: string): string {
  let out = line;

  out = out.replace(/\*\*(\S[^*]*\S|\S)\*\*/g, (_, m: string) => bold(m));
  out = out.replace(/\*(\S[^*]*\S|\S)\*/g, (_, m: string) => italic(m));
  out = out.replace(/`([^`]+)`/g, (_, m: string) => bgGray(` ${m} `));
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, text: string, url: string) => `${underline(text)} ${dim(`(${url})`)}`,
  );

  return out;
}
