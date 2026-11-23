/** House style for everything the bot says: no em dashes, and no spaced en dashes used as one. */
export function scrubDashes(text: string): string {
    return text.replace(/[ \t]*—[ \t]*|[ \t]+–[ \t]+/g, ", ");
}
