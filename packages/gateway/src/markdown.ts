/**
 * Convert model markdown into Telegram-safe HTML and split it into messages.
 *
 * Telegram supports a small HTML subset (<b>, <i>, <s>, <code>, <pre>, <a>,
 * <blockquote>). Rendering happens per source line/code block so a chunk never
 * cuts through an open tag.
 */

export const TELEGRAM_CHUNK_LIMIT = 3_900;
const NUL = "\u0000";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|tg:\/\/|mailto:)/i.test(url);
}

interface Protected {
  store: string[];
  token(html: string): string;
}

function createProtector(): Protected {
  const store: string[] = [];
  return {
    store,
    token(html: string): string {
      const index = store.push(html) - 1;
      return `${NUL}${index}${NUL}`;
    },
  };
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<i>$1</i>");
}

/** Render inline markdown for one line of text. */
export function renderInline(raw: string): string {
  const protector = createProtector();
  let text = raw.replaceAll(NUL, "");

  // Inline code first: its content must stay literal.
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks: string, code: string) =>
    protector.token(`<code>${escapeHtml(code.trim())}</code>`),
  );

  // Markdown links and <autolinks>.
  text = text.replace(
    /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g,
    (_match, label: string, url: string) => {
      if (!isSafeUrl(url)) return label;
      return protector.token(
        `<a href="${escapeAttr(url)}">${emphasis(escapeHtml(label))}</a>`,
      );
    },
  );
  text = text.replace(/<(https?:\/\/[^\s>]+)>/g, (_match, url: string) =>
    protector.token(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`),
  );

  text = emphasis(escapeHtml(text));

  return text.replaceAll(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return protector.store[Number(index)] ?? "";
  });
}

function renderHeading(line: string): string {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
  if (!match) return renderInline(line);
  return `<b>${renderInline(match[1] ?? "")}</b>`;
}

function renderListLine(line: string): string | undefined {
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const indent = " ".repeat(Math.min((task[1] ?? "").length, 8));
    const box = (task[2] ?? "").toLowerCase() === "x" ? "☑" : "☐";
    return `${indent}${box} ${renderInline(task[3] ?? "")}`;
  }

  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) {
    const indent = " ".repeat(Math.min((bullet[1] ?? "").length, 8));
    return `${indent}• ${renderInline(bullet[2] ?? "")}`;
  }

  const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (ordered) {
    const indent = " ".repeat(Math.min((ordered[1] ?? "").length, 8));
    return `${indent}${ordered[2]}. ${renderInline(ordered[3] ?? "")}`;
  }

  return undefined;
}

function renderLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+/.test(line);
  if (heading) return renderHeading(line);

  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "──────────";

  const list = renderListLine(line);
  if (list !== undefined) return list;

  const quote = line.match(/^\s{0,3}>\s?(.*)$/);
  if (quote) return `<blockquote>${renderInline(quote[1] ?? "")}</blockquote>`;

  return renderInline(line);
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function splitRawLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) pieces.push(rest);
  return pieces;
}

interface Block {
  html: string;
}

function codeBlock(lang: string, content: string, max: number): Block[] {
  const language = lang.replace(/[^\w+-]/g, "").slice(0, 32);
  const open = language
    ? `<pre><code class="language-${language}">`
    : "<pre><code>";
  const close = "</code></pre>";
  const room = Math.max(200, max - open.length - close.length - 2);
  const body = content.replace(/\s+$/, "");

  if (body.length <= room) {
    return [{ html: `${open}${escapeHtml(body)}${close}` }];
  }

  const blocks: Block[] = [];
  let rest = body;
  while (rest.length > room) {
    let cut = rest.lastIndexOf("\n", room);
    if (cut <= 0) cut = room;
    blocks.push({ html: `${open}${escapeHtml(rest.slice(0, cut))}${close}` });
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) blocks.push({ html: `${open}${escapeHtml(rest)}${close}` });
  return blocks;
}

/** Parse markdown into rendered blocks that each fit under `max`. */
function blocks(markdown: string, max: number): Block[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const out: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    for (const raw of paragraph) {
      for (const piece of splitRawLine(raw, max - 50)) {
        out.push({ html: renderLine(piece) });
      }
    }
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? "```";
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      out.push(...codeBlock(lang, body.join("\n"), max));
      continue;
    }

    if (isTableRow(line)) {
      flushParagraph();
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push((lines[i] ?? "").trim());
        i += 1;
      }
      i -= 1;

      let table = "";
      for (const row of rows) {
        if (table && table.length + row.length + 1 > max - 30) {
          out.push({ html: `<pre>${escapeHtml(table)}</pre>` });
          table = "";
        }
        table = table ? `${table}\n${row}` : row;
      }
      if (table) out.push({ html: `<pre>${escapeHtml(table)}</pre>` });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return out;
}

/** Render markdown and pack blocks into Telegram-sized HTML messages. */
export function toTelegramChunks(
  markdown: string,
  limit = TELEGRAM_CHUNK_LIMIT,
): string[] {
  const rendered = blocks(markdown, limit);
  const chunks: string[] = [];
  let current = "";

  const push = (block: string) => {
    if (!block) return;
    if (current && current.length + block.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${block}` : block;
  };

  for (const block of rendered) {
    push(block.html);
  }
  if (current.trim()) chunks.push(current);

  return chunks.length > 0 ? chunks : [""];
}

/** Strip tags for a plain-text fallback when Telegram rejects the markup. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, (_match, url: string, label: string) =>
      label === url ? label : `${label} (${url})`,
    )
    .replace(/<\/(pre|blockquote)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}
