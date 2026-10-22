import { test } from "node:test";
import assert from "node:assert/strict";
import { Splitter, split, splitStream, splitText } from "../dist/index.js";

function streamed(text, sizes, options) {
  const splitter = new Splitter(options);
  const out = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const size = sizes[n++ % sizes.length];
    out.push(...splitter.push(text.slice(i, i + size)));
    i += size;
  }
  out.push(...splitter.flush());
  return out;
}

test("emits each sentence as soon as the next one starts", () => {
  const s = new Splitter();
  assert.deepEqual(s.push("Hello there"), []);
  assert.deepEqual(s.push(". How"), ["Hello there."]);
  assert.deepEqual(s.push(" are you? I'm"), ["How are you?"]);
  assert.deepEqual(s.push(" fine!"), []);
  assert.deepEqual(s.flush(), ["I'm fine!"]);
});

test("does not split decimals, domains, abbreviations or initials", () => {
  assert.deepEqual(
    splitText("Pi is 3.14 roughly. Visit example.com today. Dr. Smith met J. R. R. Tolkien. Use tools, e.g. Python. Done."),
    ["Pi is 3.14 roughly.", "Visit example.com today.", "Dr. Smith met J. R. R. Tolkien.", "Use tools, e.g. Python.", "Done."],
  );
});

test("does not split before a lowercase word", () => {
  assert.deepEqual(splitText("Wait... what happened? Nothing."), ["Wait... what happened?", "Nothing."]);
});

test("keeps closing quotes, brackets and emphasis with the sentence", () => {
  assert.deepEqual(splitText('He said "Go." Then (he left.) **Bold.** End.'), [
    'He said "Go."',
    "Then (he left.)",
    "**Bold.**",
    "End.",
  ]);
});

test("ignores periods inside inline code", () => {
  assert.deepEqual(splitText("Call `a. B. c` now. Next."), ["Call `a. B. c` now.", "Next."]);
});

test("splits CJK sentences without spaces", () => {
  assert.deepEqual(splitText("你好。今天天气很好！是吗？"), ["你好。", "今天天气很好！", "是吗？"]);
});

test("keeps code fences whole, including blank lines and periods", () => {
  const md = "Run this. Then:\n\n```js\nconst a = 1.5;\n\nconsole.log(a). Done\n```\nAfter it.";
  assert.deepEqual(splitText(md), [
    "Run this.",
    "Then:",
    "```js\nconst a = 1.5;\n\nconsole.log(a). Done\n```",
    "After it.",
  ]);
});

test("closes a fence only with a matching or longer fence", () => {
  const md = "````md\n```js\nx\n```\n````\nok";
  assert.deepEqual(splitText(md), ["````md\n```js\nx\n```\n````", "ok"]);
});

test("emits an unterminated code fence on flush", () => {
  assert.deepEqual(splitText("```py\nprint(1)\n"), ["```py\nprint(1)"]);
});

test("does not split at a list marker", () => {
  assert.deepEqual(splitText("1. Install it. Then run it.\n2. Done.\n- Bullet. Two."), [
    "1. Install it.",
    "Then run it.",
    "2. Done.",
    "- Bullet.",
    "Two.",
  ]);
});

test("block mode emits paragraphs, list items, headings, quotes, tables, rules and math", () => {
  const md = [
    "# Title",
    "First sentence. Second sentence",
    "wraps here.",
    "",
    "- one. still one",
    "  continued",
    "- two",
    "  - nested",
    "",
    "> quote line one.",
    "> quote line two.",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "---",
    "$$",
    "x = 1. y = 2",
    "$$",
    "Last.",
  ].join("\n");
  assert.deepEqual(splitText(md, { mode: "block" }), [
    "# Title",
    "First sentence. Second sentence\nwraps here.",
    "- one. still one\n  continued",
    "- two",
    "- nested",
    "> quote line one.\n> quote line two.",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "---",
    "$$\nx = 1. y = 2\n$$",
    "Last.",
  ]);
});

test("sentence mode keeps headings and tables whole", () => {
  const md = "## Step 1. Setup\nDo it. Now.\n| a. b | c. d |\n| - | - |\nEnd.";
  assert.deepEqual(splitText(md), ["## Step 1. Setup", "Do it.", "Now.", "| a. b | c. d |\n| - | - |", "End."]);
});

test("handles CRLF line endings", () => {
  assert.deepEqual(splitText("One.\r\n\r\n- Two.\r\n- Three.\r\n"), ["One.", "- Two.", "- Three."]);
});

test("output does not depend on how the stream is chunked", () => {
  const md = [
    "# Intro",
    "LLMs stream tokens. We want sentences, e.g. for TTS! Is it fast? Yes... very fast.",
    "",
    "1. First, install `npm i x. y`. Then import it.",
    "2. Use **bold.** text.",
    "   ```bash",
    "   echo hi. there",
    "   ```",
    "* * *",
    "> Quoted. Text here.",
    "| x | y |",
    "| - | - |",
    "你好。世界！",
    "Ends without a newline",
  ].join("\n");
  for (const mode of ["sentence", "block"]) {
    const expected = splitText(md, { mode });
    for (const sizes of [[1], [2], [3], [5, 1, 7], [13, 2], [64]]) {
      assert.deepEqual(streamed(md, sizes, { mode }), expected, `mode=${mode} sizes=${sizes}`);
    }
  }
});

test("split() works with async iterables", async () => {
  async function* tokens() {
    yield* ["Hel", "lo. ", "Wor", "ld.", undefined, "\n\n```\ncode\n```"];
  }
  const out = [];
  for await (const s of split(tokens())) out.push(s);
  assert.deepEqual(out, ["Hello.", "World.", "```\ncode\n```"]);
});

test("splitStream() works with Web Streams", async () => {
  const source = ReadableStream.from(["A b. ", "C d", "! E"]);
  const out = [];
  for await (const s of source.pipeThrough(splitStream())) out.push(s);
  assert.deepEqual(out, ["A b.", "C d!", "E"]);
});

test("rejects bad input with a helpful message", () => {
  assert.throws(() => new Splitter({ mode: "word" }), /mode must be "sentence" or "block"/);
  assert.throws(() => new Splitter().push(42), /expects a string/);
});
