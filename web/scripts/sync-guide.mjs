// Copies the write CLI's guide (crates/write-cli/src/guide.md, the same text `write docs` prints) into content/, so
// the web serves it at /docs without reading outside its own directory.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const source = join(root, "..", "crates", "write-cli", "src", "guide.md");
if (existsSync(source)) copyFileSync(source, join(root, "content", "cli-guide.md"));
