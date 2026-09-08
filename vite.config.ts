import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        gamepad: resolve(import.meta.dirname, "gamepad.html"),
      },
    },
  },
});
