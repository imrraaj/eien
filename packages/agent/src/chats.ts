import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";

/** Which conversation serves each chat, keyed by `addressKey`. */
export const Chats = defineDoc<{ conversations: Record<string, ConversationId> }>({
    checkpointWhen: () => false,
    kind: "eien.chats",
    version: 1,
    scope: "session",
    initial: () => ({ conversations: {} }),
});

/** Newest assistant entry already handed to the chat, so a restart neither drops nor repeats answers. */
export const Delivery = defineDoc<{ delivered: number }>({
    checkpointWhen: () => false,
    kind: "eien.delivery",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ delivered: 0 }),
});
