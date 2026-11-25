import type { FeedItem, LiveState, ServerMessage, StoredFile } from "@eien/web/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, connectEvents } from "./api.ts";

/** Everything the transcript shows, in arrival order. Notices and files sit between feed items. */
export type Row =
    | { readonly kind: "item"; readonly item: FeedItem }
    | { readonly kind: "notice"; readonly key: string; readonly text: string; readonly at: number }
    | { readonly kind: "file"; readonly key: string; readonly file: StoredFile }
    /** Sent, not yet in the transcript (a steer waits for the current tool round). */
    | { readonly kind: "pending"; readonly key: string; readonly text: string; readonly files: readonly string[] };

interface State {
    rows: Row[];
    live: LiveState;
    /** Cursor for older history; undefined once the start is loaded. */
    before?: number;
    loading: boolean;
    connected: boolean;
}

type Action =
    | { type: "history"; items: readonly FeedItem[]; before?: number; prepend: boolean }
    | { type: "server"; message: ServerMessage }
    | { type: "pending"; key: string; text: string; files: readonly string[] }
    | { type: "unpend"; key: string; notice?: string }
    | { type: "loading"; loading: boolean }
    | { type: "connected"; connected: boolean };

const idle: LiveState = { busy: false, tools: [] };

const itemRow = (item: FeedItem): Row => ({ kind: "item", item });

function newestId(rows: readonly Row[]): number {
    for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]!;
        if (row.kind === "item") return row.item.id;
    }
    return 0;
}

/** Add feed items not seen yet; a user item retires the pending row it answers. */
function appendItems(rows: Row[], items: readonly FeedItem[]): Row[] {
    const seen = new Set(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : [])));
    let next = rows;
    for (const item of items) {
        if (seen.has(item.id)) continue;
        if (item.kind === "user") {
            const pending = next.findIndex((row) => row.kind === "pending" && item.text.startsWith(row.text));
            if (pending >= 0) next = next.filter((_, index) => index !== pending);
        }
        next = [...next, itemRow(item)];
    }
    return next;
}

function reduce(state: State, action: Action): State {
    switch (action.type) {
        case "history": {
            const rows = action.prepend
                ? [...action.items.map(itemRow), ...state.rows]
                : appendItems(
                      state.rows.filter((row) => row.kind !== "item"),
                      action.items,
                  );
            return { ...state, rows, before: action.before, loading: false };
        }
        case "server": {
            const message = action.message;
            switch (message.type) {
                case "feed":
                    return message.event.kind === "live"
                        ? { ...state, live: message.event.live }
                        : { ...state, rows: appendItems(state.rows, message.event.items) };
                case "notice":
                    return {
                        ...state,
                        rows: [
                            ...state.rows,
                            {
                                kind: "notice",
                                key: `n${message.at}${state.rows.length}`,
                                text: message.text,
                                at: message.at,
                            },
                        ],
                    };
                case "file":
                    return {
                        ...state,
                        rows: [...state.rows, { kind: "file", key: message.file.id, file: message.file }],
                    };
                case "status":
                    return state;
            }
            return state;
        }
        case "pending":
            return {
                ...state,
                rows: [...state.rows, { kind: "pending", key: action.key, text: action.text, files: action.files }],
            };
        case "unpend": {
            const rows = state.rows.filter((row) => !(row.kind === "pending" && row.key === action.key));
            return action.notice
                ? {
                      ...state,
                      rows: [...rows, { kind: "notice", key: `e${action.key}`, text: action.notice, at: Date.now() }],
                  }
                : { ...state, rows };
        }
        case "loading":
            return { ...state, loading: action.loading };
        case "connected":
            return { ...state, connected: action.connected };
    }
}

export function useConversation(onUnauthorized: () => void) {
    const [state, dispatch] = useReducer(reduce, { rows: [], live: idle, loading: true, connected: false });
    const rowsRef = useRef(state.rows);
    rowsRef.current = state.rows;

    useEffect(() => {
        let stop: (() => void) | undefined;
        let cancelled = false;
        api.history()
            .then((page) => {
                if (cancelled) return;
                dispatch({ type: "history", items: page.items, before: page.before, prepend: false });
                stop = connectEvents({
                    after: () => newestId(rowsRef.current),
                    onMessage: (message) => dispatch({ type: "server", message }),
                    onState: (socketState) => dispatch({ type: "connected", connected: socketState === "open" }),
                });
            })
            .catch(onUnauthorized);
        return () => {
            cancelled = true;
            stop?.();
        };
    }, [onUnauthorized]);

    const loadEarlier = useCallback(async () => {
        if (state.before === undefined) return;
        dispatch({ type: "loading", loading: true });
        const page = await api.history(state.before).catch(() => undefined);
        if (page) dispatch({ type: "history", items: page.items, before: page.before, prepend: true });
        else dispatch({ type: "loading", loading: false });
    }, [state.before]);

    const send = useCallback(async (text: string, files: readonly File[]) => {
        const key = crypto.randomUUID();
        const isCommand = text.startsWith("/") && files.length === 0;
        if (!isCommand) dispatch({ type: "pending", key, text, files: files.map((file) => file.name) });
        try {
            await api.send(key, text, files);
        } catch (error) {
            dispatch({
                type: "unpend",
                key,
                notice: `Not sent: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }, []);

    return { ...state, loadEarlier, send };
}
