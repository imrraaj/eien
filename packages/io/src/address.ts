import type { Address } from "./types.ts";

/** Stable string form of an address, `service:chat`. */
export function addressKey(address: Address): string {
    return `${address.service}:${address.chat}`;
}

/** Inverse of `addressKey`; the chat part may itself contain colons. */
export function parseAddressKey(key: string): Address | undefined {
    const split = key.indexOf(":");
    if (split <= 0 || split === key.length - 1) return undefined;
    return { service: key.slice(0, split), chat: key.slice(split + 1) };
}
