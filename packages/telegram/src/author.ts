import type { Author } from "@eien/io";

/** The Telegram fields we need to identify a sender. */
export interface TelegramUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
}

/** Stable author metadata for a group message; names are display-only, the id is identity. */
export function authorFrom(user: TelegramUser): Author {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || String(user.id);
    return {
        id: String(user.id),
        name,
        ...(user.username ? { username: user.username } : {}),
    };
}
