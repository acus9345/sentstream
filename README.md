# sentstream

A streaming sentence splitter for LLM output.

Feed it tokens as they arrive. It hands back each complete sentence, or each complete markdown block (paragraph, list item, code fence, table...), the moment it is finished. Useful for text-to-speech, translation, moderation, or rendering chat output piece by piece.

- Zero dependencies, tiny, works in Node, Deno, Bun and browsers.
- Same output however the stream is chunked: one character at a time or all at once.
- Knows markdown: never splits inside code fences, math blocks, tables or inline code, and never at a `1.` list marker.
- Handles abbreviations (`Dr.`, `e.g.`), decimals (`3.14`), domains (`example.com`), initials (`J. R. R. Tolkien`), ellipses, closing quotes and brackets, and CJK punctuation (`。！？`).

## Install

```sh
npm install sentstream
```

## Quick start

```js
import { Splitter } from "sentstream";

const splitter = new Splitter();
console.log(splitter.push("Hello there. How a")); // [ 'Hello there.' ]
console.log(splitter.push("re you? I'm fi"));     // [ 'How are you?' ]
console.log(splitter.flush());                    // [ "I'm fi" ]
```

A sentence is emitted once the text after it has started, so `"Hello there."` alone stays buffered until the next token shows it is not `"Hello there.com"`. Call `flush()` when the stream ends to get the rest.

## With an LLM stream

`split()` takes any async iterable of strings (`null` and `undefined` chunks are skipped):

```js
import { split } from "sentstream";

async function* tokens() {
  // Replace with your SDK's text deltas, e.g. chunk.choices[0]?.delta?.content
  yield* ["Sure! Here", "'s the plan.", " First, install it:\n\n```sh\nnpm i x\n```\n", "Done."];
}

for await (const sentence of split(tokens())) {
  console.log(JSON.stringify(sentence));
}
// "Sure!"
// "Here's the plan."
// "First, install it:"
// "```sh\nnpm i x\n```"
// "Done."
```

With Web Streams, use `splitStream()`:

```js
const sentences = response.body
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(splitStream());
```

## Modes

| Mode | Prose | Code fences, `$$` math, tables | Headings, rules |
| --- | --- | --- | --- |
| `"sentence"` (default) | one sentence at a time | whole | whole line |
| `"block"` | one paragraph / list item / blockquote at a time | whole | whole line |

```js
import { splitText } from "sentstream";

splitText("- One. Two.\n- Three.", { mode: "block" });
// [ '- One. Two.', '- Three.' ]

splitText("- One. Two.\n- Three.");
// [ '- One.', 'Two.', '- Three.' ]
```

Segments are the original markdown, trimmed. A list item's first sentence keeps its `- ` marker; strip markdown yourself if you need plain text.

## API

- `new Splitter(options?)`: `push(chunk): string[]` returns the segments that chunk completed; `flush(): string[]` returns the rest and resets the splitter.
- `split(source, options?)`: async generator over an `AsyncIterable<string>` or `Iterable<string>`.
- `splitStream(options?)`: a `TransformStream<string, string>`.
- `splitText(text, options?)`: split a whole string at once.

`options.mode` is `"sentence"` (default) or `"block"`.

## Build from source

```sh
git clone https://github.com/acus9345/sentstream.git
cd sentstream
npm install
npm test
```

## License

MIT
