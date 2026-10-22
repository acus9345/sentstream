/**
 * sentstream: a streaming sentence splitter for LLM output.
 *
 * Feed it tokens as they arrive; it hands back each sentence (or markdown block)
 * the moment it is complete. Segments are raw markdown slices, trimmed.
 */

export type Mode = "sentence" | "block";

export interface SplitOptions {
  /**
   * - `"sentence"` (default): prose is emitted one sentence at a time, as soon as
   *   each sentence ends. Code fences, math blocks, tables, headings and rules are
   *   still emitted whole.
   * - `"block"`: whole markdown blocks are emitted: paragraphs, list items,
   *   blockquotes, headings, rules, code fences, math blocks and tables.
   */
  mode?: Mode;
}

type Block = "paragraph" | "list" | "quote" | "table" | "code" | null;
type LineKind = "blank" | "fence" | "math" | "heading" | "rule" | "table" | "list" | "quote" | "text";
type ProseKind = "text" | "list" | "quote";

const BLANK = /^\s*$/;
const FENCE = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const MATH = /^\s*\$\$\s*$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}\s*$/;
const TABLE = /^\s*\|/;
const LIST = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s*/;
const QUOTE = /^\s*>/;
const MAYBE_RULE = /^[-*_](?:\s*[-*_])*\s*$/;
const MARKER_START = /^[-*+_#`~|>$\d]/;

const TERMINATORS = ".!?…。！？";
const CJK_TERMINATORS = "。！？";
const CLOSERS = "\"'”’)]}*_»」』）";
const WS = /\s/;
const LOWER = /\p{Ll}/u;
const INITIALS = /^(?:\p{Lu}\.)*\p{Lu}$/u;
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "vs", "e.g", "i.e", "cf", "al",
  "approx", "fig", "figs", "no", "nos", "vol", "eq", "eqs", "ca",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

function classify(line: string): LineKind {
  if (BLANK.test(line)) return "blank";
  if (FENCE.test(line)) return "fence";
  if (MATH.test(line)) return "math";
  if (HEADING.test(line)) return "heading";
  if (RULE.test(line)) return "rule";
  if (TABLE.test(line)) return "table";
  if (LIST.test(line)) return "list";
  if (QUOTE.test(line)) return "quote";
  return "text";
}

/**
 * Classify a line that has not ended yet. Only prose lines are decided early
 * (so their sentences can stream out); anything that might still turn into a
 * heading, fence, rule or table waits for the newline.
 */
function classifyPartial(line: string): ProseKind | undefined {
  const s = line.trimStart();
  if (s === "") return undefined;
  if (!WS.test(s)) return MARKER_START.test(s) ? undefined : "text";
  if (MAYBE_RULE.test(s)) return undefined;
  const kind = classify(line);
  return kind === "text" || kind === "list" || kind === "quote" ? kind : undefined;
}

function closes(line: string, fence: string): boolean {
  if (fence === "$$") return MATH.test(line);
  const m = FENCE_CLOSE.exec(line);
  return m !== null && m[1][0] === fence[0] && m[1].length >= fence.length;
}

function isAbbreviation(text: string, dot: number): boolean {
  let s = dot;
  while (s > 0 && !WS.test(text[s - 1])) s--;
  const word = text.slice(s, dot).replace(/^[^\p{L}\p{N}]+/u, "");
  if (word !== "I" && INITIALS.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

function emit(out: string[], text: string): void {
  const t = text.trim();
  if (t !== "") out.push(t);
}

/**
 * Incremental splitter. Call `push()` with each chunk of text and `flush()` once
 * the stream ends; both return the segments completed by that call.
 *
 * @example
 * const splitter = new Splitter();
 * splitter.push("Hello there. How a"); // ["Hello there."]
 * splitter.push("re you?");            // []
 * splitter.flush();                     // ["How are you?"]
 */
export class Splitter {
  readonly mode: Mode;
  private buf = ""; // current line, not yet consumed
  private lineOpen = false; // current line already decided as prose and moved into `cur`
  private block: Block = null;
  private cur = ""; // text of the current block that has not been emitted
  private fence = "";
  private scan = 0; // where sentence scanning resumes in `cur`
  private code = 0; // length of the open inline-code backtick run at `scan`, or 0

  constructor(options: SplitOptions = {}) {
    const mode = options.mode ?? "sentence";
    if (mode !== "sentence" && mode !== "block") {
      throw new TypeError(`sentstream: mode must be "sentence" or "block", got ${JSON.stringify(mode)}.`);
    }
    this.mode = mode;
  }

  /** Add a chunk of text. Returns the segments it completed. `null`/`undefined` are ignored. */
  push(chunk: string | null | undefined): string[] {
    if (chunk == null) return [];
    if (typeof chunk !== "string") {
      throw new TypeError(`sentstream: push() expects a string, got ${typeof chunk}.`);
    }
    const out: string[] = [];
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (this.lineOpen) {
        if (nl === -1) {
          this.cur += this.buf;
          this.buf = "";
          break;
        }
        this.cur += this.buf.slice(0, nl + 1);
        this.buf = this.buf.slice(nl + 1);
        this.lineOpen = false;
        continue;
      }
      if (nl !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        this.line(line, out);
        continue;
      }
      if (this.mode === "sentence" && this.block !== "code") {
        const kind = classifyPartial(this.buf);
        if (kind !== undefined) {
          this.open(kind, this.buf, out);
          this.cur += this.buf;
          this.buf = "";
          this.lineOpen = true;
        }
      }
      break;
    }
    if (this.isProse()) this.drain(false, out);
    return out;
  }

  /** End of stream: returns whatever is left. The splitter can be reused afterwards. */
  flush(): string[] {
    const out: string[] = [];
    if (this.lineOpen) this.cur += this.buf;
    else if (this.buf !== "") this.line(this.buf, out);
    this.buf = "";
    this.lineOpen = false;
    this.end(out);
    return out;
  }

  private isProse(): boolean {
    return this.mode === "sentence" && (this.block === "paragraph" || this.block === "list" || this.block === "quote");
  }

  private line(line: string, out: string[]): void {
    if (this.block === "code") {
      this.cur += line + "\n";
      if (closes(line, this.fence)) this.end(out);
      return;
    }
    const kind = classify(line);
    switch (kind) {
      case "blank":
        this.end(out);
        return;
      case "fence":
      case "math": {
        this.end(out);
        const m = FENCE.exec(line);
        this.block = "code";
        this.fence = kind === "math" ? "$$" : (m![1] ?? m![2]);
        this.cur = line + "\n";
        return;
      }
      case "heading":
      case "rule":
        this.end(out);
        emit(out, line);
        return;
      case "table":
        if (this.block !== "table") {
          this.end(out);
          this.block = "table";
        }
        this.cur += line + "\n";
        return;
      default:
        this.open(kind, line, out);
        this.cur += line + "\n";
    }
  }

  /** Start a prose line: either continue the current block or begin a new one. */
  private open(kind: ProseKind, line: string, out: string[]): void {
    if (kind === "list") {
      this.end(out);
      this.block = "list";
      this.scan = LIST_MARKER.exec(line)![0].length; // never split at "1." itself
    } else if (kind === "quote") {
      if (this.block !== "quote") {
        this.end(out);
        this.block = "quote";
      }
    } else if (this.block !== "paragraph" && this.block !== "list" && this.block !== "quote") {
      this.end(out);
      this.block = "paragraph";
    }
  }

  private end(out: string[]): void {
    if (this.isProse()) this.drain(true, out);
    else emit(out, this.cur);
    this.block = null;
    this.cur = "";
    this.scan = 0;
    this.code = 0;
  }

  /** Emit every complete sentence in `cur`. With `final`, also emit the remainder. */
  private drain(final: boolean, out: string[]): void {
    const text = this.cur;
    let start = 0;
    let i = this.scan;
    let code = this.code;
    while (i < text.length) {
      const c = text[i];
      if (c === "`") {
        let n = 1;
        while (text[i + n] === "`") n++;
        if (i + n === text.length && !final) break; // the run may continue in the next chunk
        code = code === 0 ? n : code === n ? 0 : code;
        i += n;
        continue;
      }
      if (code !== 0 || !TERMINATORS.includes(c)) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < text.length && TERMINATORS.includes(text[j])) j++;
      const last = text[j - 1];
      while (j < text.length && CLOSERS.includes(text[j])) j++;
      if (j === text.length) break; // need to see what follows
      if (!CJK_TERMINATORS.includes(last)) {
        if (!WS.test(text[j])) {
          i = j; // "3.14", "example.com"
          continue;
        }
        if (last === "." || last === "…") {
          let k = j;
          while (k < text.length && WS.test(text[k])) k++;
          if (k === text.length) {
            if (!final) break;
          } else if (LOWER.test(text[k]) || isAbbreviation(text, i)) {
            i = k; // "e.g. this", "Dr. Smith", "wait... what"
            continue;
          }
        }
      }
      emit(out, text.slice(start, j));
      start = i = j;
    }
    if (final) {
      emit(out, text.slice(start));
      this.cur = "";
      this.scan = 0;
      this.code = 0;
      return;
    }
    this.cur = text.slice(start);
    this.scan = i - start;
    this.code = code;
  }
}

/** Split a whole string at once. Handy for tests and non-streaming input. */
export function splitText(text: string, options?: SplitOptions): string[] {
  const splitter = new Splitter(options);
  return [...splitter.push(text), ...splitter.flush()];
}

/**
 * Turn a stream of text chunks into a stream of sentences or blocks.
 *
 * @example
 * for await (const sentence of split(tokens)) speak(sentence);
 */
export async function* split(
  source: AsyncIterable<string | null | undefined> | Iterable<string | null | undefined>,
  options?: SplitOptions,
): AsyncGenerator<string, void, undefined> {
  const splitter = new Splitter(options);
  for await (const chunk of source) yield* splitter.push(chunk);
  yield* splitter.flush();
}

/**
 * A Web Streams `TransformStream` version, for `ReadableStream.pipeThrough()`.
 *
 * @example
 * response.body.pipeThrough(new TextDecoderStream()).pipeThrough(splitStream());
 */
export function splitStream(options?: SplitOptions): TransformStream<string, string> {
  const splitter = new Splitter(options);
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      for (const s of splitter.push(chunk)) controller.enqueue(s);
    },
    flush(controller) {
      for (const s of splitter.flush()) controller.enqueue(s);
    },
  });
}
