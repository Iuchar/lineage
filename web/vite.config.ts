import { defineConfig } from "vite";

// в разработке интерфейс живёт на своём порту, а запросы к API уходят на сервер
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    open: false,
    proxy: { "/api": "http://127.0.0.1:8710" },
  },
});
