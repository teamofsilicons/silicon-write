// Vendors Silicon UI components (https://ui.teamofsilicons.com/r/{name}.json) into components/silicon-ui/,
// following their registry dependencies, and records each file's sha256 in silicon-ui-registry.json.
// Files that already exist are kept (the kit carries local edits); pass --force to replace them.
//
//   node scripts/vendor-ui.mjs dropdown-menu dialog popover
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const force = process.argv.includes("--force");
const names = process.argv.slice(2).filter(a => !a.startsWith("--"));
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const manifestPath = join(root, "silicon-ui-registry.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const seen = new Set();
const npmDeps = new Set();

function target(path) {
  if (path.startsWith("registry/components/")) return join("components/silicon-ui", path.slice("registry/components/".length));
  if (path.startsWith("registry/")) return join("components/silicon-ui", path.slice("registry/".length));
  return join("components/silicon-ui", path);
}

async function vendor(ref) {
  const url = ref.startsWith("http") ? ref : `https://ui.teamofsilicons.com/r/${ref}.json`;
  if (seen.has(url)) return;
  seen.add(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const item = await response.json();
  for (const dep of item.dependencies ?? []) npmDeps.add(dep);
  for (const dep of item.registryDependencies ?? []) await vendor(dep);
  for (const file of item.files ?? []) {
    const out = target(file.path);
    const full = join(root, out);
    const sha256 = createHash("sha256").update(file.content).digest("hex");
    if (existsSync(full) && !force) {
      console.log(`kept     ${out}`);
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.content);
      console.log(`wrote    ${out}`);
    }
    if (!manifest.files[out] || force) manifest.files[out] = { registry: url, sha256 };
  }
}

for (const name of names) await vendor(name);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`npm packages these use: ${[...npmDeps].join(", ") || "none"}`);
