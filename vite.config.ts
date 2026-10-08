import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],

  // Don't let Vite paint over Rust compiler errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    /* Not the per-card scratch directories either. Every card on the wall
       keeps its working files in `.scratch-<handle>/`, and some of those are
       running binaries a card copied there to test with — and watching a file
       Windows has locked for execution is an EBUSY that takes the whole dev
       server down, and with it every wall loading from this port. Nothing in a
       scratch directory is ever source. */
    watch: { ignored: ["**/src-tauri/**", "**/.scratch*/**"] },
  },
});
