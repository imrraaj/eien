import { describe, expect, test } from "bun:test";
import { sameOrigin, tokenMatches } from "../../packages/web/src/auth.ts";

const request = (headers: Record<string, string>) => new Request("http://127.0.0.1:8787/api/login", { headers });

describe("sameOrigin", () => {
    test("allows requests without an Origin and same-host origins", () => {
        expect(sameOrigin(request({ host: "127.0.0.1:8787" }))).toBe(true);
        expect(sameOrigin(request({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }))).toBe(true);
        expect(sameOrigin(request({ host: "127.0.0.1:8787", origin: "https://evil.example" }))).toBe(false);
        expect(sameOrigin(request({ host: "127.0.0.1:8787", origin: "not a url" }))).toBe(false);
    });

    test("with an allow-list, only listed origins pass, whatever Host a proxy sent", () => {
        const allowed = ["https://eien.example.com"];
        const proxied = { host: "127.0.0.1:8787" };
        expect(sameOrigin(request({ ...proxied, origin: "https://eien.example.com" }), allowed)).toBe(true);
        expect(sameOrigin(request({ ...proxied, origin: "http://127.0.0.1:8787" }), allowed)).toBe(false);
    });
});

test("tokenMatches compares exactly", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("abc ", "abc")).toBe(false);
});
