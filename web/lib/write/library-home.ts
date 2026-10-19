import type { Library } from "./types";

/** Only merge the root listings: the shared endpoint preserves each shared folder as a folder. */
export function homeLibrary(mine?: Library, shared?: Library): Library {
  const docs = new Map(shared?.docs.map(doc => [doc.id, doc]));
  const folders = new Map(shared?.folders.map(folder => [folder.id, folder]));
  // Ownership wins if an item appears in both cached responses during a transfer.
  for (const doc of mine?.docs ?? []) docs.set(doc.id, doc);
  for (const folder of mine?.folders ?? []) folders.set(folder.id, folder);
  return {
    folder: null,
    docs: [...docs.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)),
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)),
  };
}
