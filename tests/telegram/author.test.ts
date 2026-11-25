import { describe, expect, test } from "bun:test";
import { authorFrom } from "../../packages/telegram/src/author.ts";

describe("authorFrom", () => {
    test("keeps both names and the username", () => {
        expect(authorFrom({ id: 42, first_name: "Ada", last_name: "Lovelace", username: "ada" })).toEqual({
            id: "42",
            name: "Ada Lovelace",
            username: "ada",
        });
    });

    test("omits a missing username", () => {
        expect(authorFrom({ id: 7, first_name: "Grace" })).toEqual({ id: "7", name: "Grace" });
    });

    test("falls back to the username and then the id", () => {
        expect(authorFrom({ id: 8, first_name: "", username: "anon" })).toEqual({
            id: "8",
            name: "anon",
            username: "anon",
        });
        expect(authorFrom({ id: 9, first_name: "" })).toEqual({ id: "9", name: "9" });
    });
});
