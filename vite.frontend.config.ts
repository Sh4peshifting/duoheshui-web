import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Lightweight UI-only preview. The production build uses vite.config.ts and the Worker plugin.
export default defineConfig({
  plugins: [react()],
});
