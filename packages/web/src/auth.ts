import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "eien_session";
const MAX_AGE_SECONDS = 30 * 86_400;

/** Cookie value derived from the access token, so the token itself never sits in the browser. */
export function sessionValue(token: string): string {
    return createHmac("sha256", token).update("eien-web-session").digest("base64url");
}

function equal(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function tokenMatches(candidate: string, token: string): boolean {
    // Compare digests so the length of the real token does not leak through timing.
    return equal(sessionValue(candidate), sessionValue(token));
}

function cookieValue(request: Request): string | undefined {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === COOKIE) return rest.join("=");
    }
    return undefined;
}

export function authenticated(request: Request, token: string): boolean {
    const value = cookieValue(request);
    return value !== undefined && equal(value, sessionValue(token));
}

function secure(request: Request): boolean {
    return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

export function loginCookie(request: Request, token: string): string {
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}${secure(request) ? "; Secure" : ""}`;
    return `${COOKIE}=${sessionValue(token)}; ${flags}`;
}

export function logoutCookie(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Requests that change state must come from this site: a missing Origin is allowed
 * (non-browser clients), a foreign one is not. With SameSite=Strict cookies this
 * closes CSRF and cross-site WebSocket hijacking. When `allowed` lists the public
 * origins, Origin must be one of them; otherwise it must match the Host header,
 * which a reverse proxy may rewrite, hence the list.
 */
export function sameOrigin(request: Request, allowed: readonly string[] = []): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    if (allowed.length > 0) return allowed.includes(origin);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    return host !== null && URL.canParse(origin) && new URL(origin).host === host;
}
