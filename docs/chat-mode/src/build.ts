// Assembles each screen fragment in ./screens into a self-contained HTML mockup in
// docs/chat-mode/, so every mockup carries the same tokens (base.css) and icons
// (sprite.html). `bun docs/chat-mode/src/build.ts [name…]` rebuilds all or some.
// A fragment may open with `<!-- root: data-skin="vellum" data-motion="still" -->`.
// The .webp beside each page is a 1280x800 capture of it; motion.html is hand-written.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const out = join(here, "..");
mkdirSync(out, { recursive: true });
const base = readFileSync(join(here, "base.css"), "utf8");
const sprite = readFileSync(join(here, "sprite.html"), "utf8");
const only = process.argv.slice(2);

for (const f of readdirSync(join(here, "screens"))) {
  if (!f.endsWith(".html")) continue;
  const name = f.replace(/\.html$/, "");
  if (only.length && !only.includes(name)) continue;
  let body = readFileSync(join(here, "screens", f), "utf8");
  const root = body.match(/^<!--\s*root:(.*?)-->/)?.[1]?.trim() ?? "";
  const title = body.match(/<!--\s*title:(.*?)-->/)?.[1]?.trim() ?? name;
  const doc = `<!doctype html>
<html lang="en" ${root}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280">
<title>volery · chat view · ${title}</title>
<!-- Generated mockup: docs/chat-mode.md describes what it shows. Studio tokens from src/lib/tokens.css. -->
<style>
${base}
</style>
</head>
<body>
${sprite}
${body}
</body>
</html>
`;
  writeFileSync(join(out, `${name}.html`), doc);
  console.log("wrote", name);
}
