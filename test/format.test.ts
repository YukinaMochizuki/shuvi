import { describe, expect, test } from "bun:test";
import { markdownToTelegramHtml, PART_LIMIT, renderParts, splitMarkdown } from "../src/telegram/format.ts";

describe("markdownToTelegramHtml", () => {
  test("the common markdown a model writes", () => {
    expect(markdownToTelegramHtml("**bold** and *italic* and `a<b>`")).toBe("<b>bold</b> and <i>italic</i> and <code>a&lt;b&gt;</code>");
    expect(markdownToTelegramHtml("## Heading")).toBe("<b>Heading</b>");
    expect(markdownToTelegramHtml("- one\n- two")).toBe("• one\n• two");
    expect(markdownToTelegramHtml("[link](https://example.com/a?b=1&c=2)")).toBe('<a href="https://example.com/a?b=1&amp;c=2">link</a>');
    expect(markdownToTelegramHtml("> quote\n> second line")).toBe("<blockquote>quote\nsecond line</blockquote>");
  });

  test("code fences are escaped verbatim, markup inside them untouched", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = **b** < c;\n```")).toBe('<pre><code class="language-ts">const a = **b** &lt; c;</code></pre>');
  });

  test("identifiers and arithmetic are not mistaken for italics", () => {
    expect(markdownToTelegramHtml("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });

  test("HTML the model writes is shown, not interpreted", () => {
    expect(markdownToTelegramHtml("<ul><li>x</li></ul>")).toBe("&lt;ul&gt;&lt;li&gt;x&lt;/li&gt;&lt;/ul&gt;");
  });
});

describe("splitMarkdown", () => {
  test("short text is one part", () => {
    expect(splitMarkdown("one\n\ntwo")).toEqual(["one\n\ntwo"]);
  });

  test("long text is cut on paragraph boundaries, every part under the limit", () => {
    const para = "x".repeat(1000);
    const parts = splitMarkdown([para, para, para, para, para].join("\n\n"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= PART_LIMIT)).toBe(true);
    expect(parts.join("\n\n")).toBe([para, para, para, para, para].join("\n\n"));
  });

  test("a code fence longer than a part is cut into fences that each close", () => {
    const code = "```\n" + Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(10)}`).join("\n") + "\n```";
    const parts = splitMarkdown(code);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.startsWith("```")).toBe(true);
      expect(p.endsWith("```")).toBe(true);
      expect(p.length).toBeLessThanOrEqual(PART_LIMIT);
    }
  });

  test("every rendered part fits Telegram's limit", () => {
    const md = Array.from({ length: 30 }, () => "**" + "b".repeat(200) + "**").join("\n\n");
    for (const p of renderParts(md)) expect(p.html.length).toBeLessThanOrEqual(4096);
  });
});
