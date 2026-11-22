import type { EntryRecord } from "@earendil-works/pi-durable";

/** The part of an entry this module reads; `EntryRecord` and typed entries both fit. */
type ModelEntry = Pick<EntryRecord, "model">;
type Message = NonNullable<EntryRecord["model"]>[number];
type Block = Exclude<Message["content"], string>[number];

function contentBlocks(entry: ModelEntry | undefined): readonly Block[] {
  return (entry?.model ?? []).flatMap((message): readonly Block[] =>
    typeof message.content === "string" ? [] : message.content,
  );
}

/** The text blocks of an entry's model messages, joined. Empty when there are none. */
export function answerText(entry: ModelEntry | undefined): string {
  return contentBlocks(entry)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

/** True when the entry also called a tool: its text is progress chatter, not an answer. */
export function callsTools(entry: ModelEntry | undefined): boolean {
  return contentBlocks(entry).some((block) => block.type === "toolCall");
}
