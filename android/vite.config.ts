import { defineConfig, type Plugin } from "vite";
import { existsSync, mkdirSync, readdirSync, copyFileSync, createReadStream } from "node:fs";
import { resolve, join, extname } from "node:path";

// The same shared WAVs as the Mac and the PC: served in dev, copied into dist/sounds on build.
const SOUNDS_DIR = resolve(__dirname, "../NotchBuddy/Resources/sounds");

function sharedSounds(): Plugin {
  const prefix = "/sounds/";
  return {
    name: "coucou-shared-sounds",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const name = decodeURIComponent(req.url.slice(prefix.length).split("?")[0]);
        if (name.includes("/") || name.includes("\\") || extname(name) !== ".wav") return next();
        const file = join(SOUNDS_DIR, name);
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", "audio/wav");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(SOUNDS_DIR)) return;
      const out = resolve(__dirname, "dist/sounds");
      mkdirSync(out, { recursive: true });
      for (const f of readdirSync(SOUNDS_DIR)) {
        if (extname(f) === ".wav") copyFileSync(join(SOUNDS_DIR, f), join(out, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [sharedSounds()],
  clearScreen: false,
  server: { port: 1421, strictPort: true, host: "0.0.0.0", fs: { allow: [resolve(__dirname, "..")] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "chrome100", minify: "esbuild", sourcemap: false, emptyOutDir: true },
});
