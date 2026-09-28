import { defineConfig } from "vite";

// в разработке интерфейс живёт на своём порту, а запросы к API уходят на сервер
const pages = process.env.RODOSLOVNYE_PAGES === "1";

export default defineConfig({
  base: pages ? "./" : "/",
  build: pages
    ? { outDir: "../docs/витрина", emptyOutDir: true, rollupOptions: { input: "index-pages.html" } }
    : {},
  server: {
    port: 5173,
    strictPort: true,
    open: false,
    proxy: { "/api": "http://127.0.0.1:8710" },
  },
});
