/** The text blocks of an assistant entry's model message, joined. Empty when there are none. */
export function answerText(entry: unknown): string {
  const model = (entry as { model?: unknown } | undefined)?.model;
  if (!Array.isArray(model)) return "";

  return model
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .flatMap((block) => {
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join("")
    .trim();
}

/** True when the assistant entry also called a tool: its text is progress chatter, not an answer. */
export function callsTools(entry: unknown): boolean {
  const model = (entry as { model?: unknown } | undefined)?.model;
  if (!Array.isArray(model)) return false;
  return model.some((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((block) => (block as { type?: unknown }).type === "toolCall");
  });
}
