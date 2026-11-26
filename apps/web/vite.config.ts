import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Vite doesn't read tsconfig `paths`, so mirror the @eien/* aliases from tsconfig.base.json.
const eien = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// In development the gateway serves the API on WEB_PORT; Vite proxies to it and keeps the
// Host header, so the gateway's same-origin checks still pass.
const gateway = `http://127.0.0.1:${process.env.WEB_PORT ?? "8787"}`;

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: [
            { find: /^@eien\/web\/protocol$/, replacement: eien("web/src/protocol.ts") },
            { find: /^@eien\/agent$/, replacement: eien("agent/src/index.ts") },
            { find: /^@eien\/io$/, replacement: eien("io/src/index.ts") },
            { find: /^@eien\/llm$/, replacement: eien("llm/src/index.ts") },
            { find: /^@eien\/sandbox$/, replacement: eien("sandbox/src/index.ts") },
            { find: /^@eien\/shared$/, replacement: eien("shared/src/index.ts") },
            { find: /^@eien\/telegram$/, replacement: eien("telegram/src/index.ts") },
            { find: /^@eien\/web$/, replacement: eien("web/src/index.ts") },
        ],
    },
    server: {
        proxy: { "/api": { target: gateway, ws: true } },
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
