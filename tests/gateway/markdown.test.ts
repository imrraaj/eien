import { describe, expect, test } from "bun:test";
import { htmlToPlainText, renderInline, toTelegramChunks } from "../../packages/gateway/src/markdown.ts";

describe("renderInline", () => {
  test("renders bold, italic, strike, and inline code", () => {
    expect(renderInline("**a** _b_ ~~c~~ `d < e`")).toBe(
      "<b>a</b> <i>b</i> <s>c</s> <code>d &lt; e</code>",
    );
  });

  test("keeps markdown characters inside code literal", () => {
    expect(renderInline("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  test("escapes html and leaves unsafe link schemes as text", () => {
    expect(renderInline("<b>hi</b> & bye")).toBe("&lt;b&gt;hi&lt;/b&gt; &amp; bye");
    expect(renderInline("[x](javascript:alert(1))")).toBe("x");
  });

  test("renders links and protects the href from emphasis", () => {
    expect(renderInline("[docs](https://a_b.com/x)")).toBe(
      '<a href="https://a_b.com/x">docs</a>',
    );
  });

  test("does not italicize underscores inside words", () => {
    expect(renderInline("snake_case_name")).toBe("snake_case_name");
  });
});

describe("toTelegramChunks", () => {
  test("renders headings, lists, and blockquotes", () => {
    const [chunk] = toTelegramChunks("## Title\n- one\n1. two\n> quote");
    expect(chunk).toContain("<b>Title</b>");
    expect(chunk).toContain("• one");
    expect(chunk).toContain("1. two");
    expect(chunk).toContain("<blockquote>quote</blockquote>");
  });

  test("wraps tables in a pre block", () => {
    const [chunk] = toTelegramChunks("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(chunk).toContain("<pre>");
    expect(chunk).toContain("| 1 | 2 |");
  });

  test("keeps fenced code intact and escapes it", () => {
    const [chunk] = toTelegramChunks("```ts\nconst a = 1 < 2;\n```");
    expect(chunk).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
  });

  test("splits long code blocks into separately wrapped chunks", () => {
    const code = Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n");
    const chunks = toTelegramChunks(`\`\`\`\n${code}\n\`\`\``, 320);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(320);
      expect(chunk.startsWith("<pre><code>")).toBe(true);
      expect(chunk.endsWith("</code></pre>")).toBe(true);
    }
    expect(chunks.join("\n")).toContain("line-79");
  });

  test("keeps every chunk balanced and under the limit", () => {
    const body = Array.from({ length: 120 }, (_, i) => `**row ${i}** with text`).join("\n\n");
    const chunks = toTelegramChunks(body, 300);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length);
      expect((chunk.match(/<code>/g) ?? []).length).toBe((chunk.match(/<\/code>/g) ?? []).length);
    }
  });

  test("falls back to a single chunk for empty text", () => {
    expect(toTelegramChunks("")).toEqual([""]);
  });
});

describe("htmlToPlainText", () => {
  test("keeps link targets and drops tags", () => {
    expect(htmlToPlainText('<b>x</b> <a href="https://e.com">site</a>')).toBe(
      "x site (https://e.com)",
    );
  });
});
