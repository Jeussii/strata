import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "node:process";
import path from "node:path";
import fs from "node:fs";

const watch = process.argv.includes("--watch");

// Where the built plugin lands.
//
// The repo root by default, which is the Obsidian convention: `main.js`,
// `manifest.json` and `styles.css` sitting next to each other is exactly what
// a plugin folder is, so you can symlink or copy the repo straight in.
//
// For a dev loop that writes into a real vault without retyping the path,
// put that path in a `.strata-out` file next to this one — it is gitignored,
// so it stays yours. `STRATA_OUT` in the environment beats both.
const localOut = (() => {
  try {
    return fs.readFileSync(".strata-out", "utf8").trim() || null;
  } catch {
    return null;
  }
})();
const OUT_DIR = process.env.STRATA_OUT ?? localOut ?? path.resolve(".");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    // Both spellings: `builtin-modules` yields bare names, but the source uses
    // the explicit `node:` prefix. Electron resolves them at runtime.
    ...builtins,
    ...builtins.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  outfile: path.join(OUT_DIR, "main.js"),
});

// esbuild only emits main.js; Obsidian also needs the manifest and stylesheet
// sitting next to it, so keep them in sync on every build.
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const file of ["manifest.json", "styles.css"]) {
  fs.copyFileSync(file, path.join(OUT_DIR, file));
}

console.log("→ output:", OUT_DIR);
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
