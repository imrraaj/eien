import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the gateway serves the API on WEB_PORT; Vite proxies to it and keeps the
// Host header, so the gateway's same-origin checks still pass.
const gateway = `http://127.0.0.1:${process.env.WEB_PORT ?? "8787"}`;

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: { "/api": { target: gateway, ws: true } },
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
