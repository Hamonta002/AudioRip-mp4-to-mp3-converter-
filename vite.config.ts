import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", ws: true },
      "/health": "http://127.0.0.1:3001",
    },
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
