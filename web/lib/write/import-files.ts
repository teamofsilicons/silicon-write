import type { Doc } from "./types";

/** Keep the picker and planner aligned with POST /v1/docs/import. */
export const IMPORT_ACCEPT = ".md,.markdown,.mdown,.txt,.text,.docx,.doc,.odt,.rtf,.html,.htm,.xhtml,.pdf";
const extensions = new Set(IMPORT_ACCEPT.split(","));
const maxFileSize = 50 * 1024 * 1024;

export interface ImportSource {
  name: string;
  size: number;
  webkitRelativePath?: string;
}

export interface PlannedFile<T extends ImportSource = File> {
  file: T;
  path: string;
  folders: string[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ImportPlan<T extends ImportSource = File> {
  files: PlannedFile<T>[];
  skipped: SkippedFile[];
}

/** Directory pickers include the selected root in webkitRelativePath. Keep it, including nested folders. */
export function planImport<T extends ImportSource>(sources: readonly T[]): ImportPlan<T> {
  const files: PlannedFile<T>[] = [];
  const skipped: SkippedFile[] = [];
  const paths = new Set<string>();
  for (const file of sources) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split("/");
    let reason = "";
    if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || /[\u0000-\u001f]/.test(part)) || parts.at(-1) !== file.name) {
      reason = "This file has an invalid folder path.";
    } else if (parts.some(part => part.startsWith(".") || part === "__MACOSX" || part === "node_modules") || file.name.startsWith("~$")) {
      reason = "Hidden or system file.";
    } else if (!extensions.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase())) {
      reason = "This file format is not supported.";
    } else if (file.size > maxFileSize) {
      reason = "This file is larger than 50 MB.";
    } else if (paths.has(path)) {
      reason = "This file was already selected.";
    }
    if (reason) {
      skipped.push({ path, reason });
      continue;
    }
    paths.add(path);
    files.push({ file, path, folders: parts.slice(0, -1) });
  }
  // A stable path order keeps each folder together, regardless of the browser's enumeration order.
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, skipped };
}

export interface ImportFailure {
  message: string;
  /** Only a definite rejection is safe to retry: these endpoints do not support idempotency. */
  retryable: boolean;
}

export type ImportEntry<T extends ImportSource = File> = PlannedFile<T> & {
  state: "pending" | "working" | "done" | "failed" | "uncertain";
  doc?: Doc;
  error?: string;
};

type FolderResult = { id: string } | { failure: ImportFailure; attempt: number };

export interface ImportBatch<T extends ImportSource = File> {
  entries: ImportEntry<T>[];
  skipped: SkippedFile[];
  parentId: string | null;
  folders: Map<string, FolderResult>;
  running: boolean;
  attempt: number;
}

export interface ImportTransport<T extends ImportSource> {
  createFolder: (name: string, parentId: string | null) => Promise<{ id: string }>;
  importFile: (file: T, folderId: string | null) => Promise<Doc>;
  describeError: (error: unknown) => ImportFailure;
}

export function createImportBatch<T extends ImportSource>(plan: ImportPlan<T>, parentId: string | null): ImportBatch<T> {
  return { entries: plan.files.map(file => ({ ...file, state: "pending" })), skipped: plan.skipped, parentId, folders: new Map(), running: false, attempt: 0 };
}

/** A response can be lost after a write. Never retry network errors, server failures or timeouts blindly. */
export function classifyImportError(error: unknown): ImportFailure {
  const value = error && typeof error === "object" ? error as { status?: unknown; code?: unknown; message?: unknown; hint?: unknown } : {};
  const status = typeof value.status === "number" ? value.status : 0;
  // These codes are emitted by authentication, upload parsing, conversion or destination access,
  // before creation. Generic invalid/conflict/not_found errors may also happen after a doc exists.
  const retryable = (status === 401 && (value.code === "unauthorized" || value.code === "signed_out"))
    || (status === 403 && value.code === "forbidden")
    || (status === 413 && value.code === "too_large")
    || ((status === 415 || status === 422) && value.code === "unsupported_format")
    || (status === 415 && value.code === "unsupported_media_type");
  const message = [typeof value.message === "string" ? value.message : "The file could not be opened.", typeof value.hint === "string" ? value.hint : ""].filter(Boolean).join(" ");
  return { retryable, message };
}

/**
 * One upload at a time bounds memory and conversion work. Completed docs and folder IDs survive retries.
 * Folder failures are shared by their children for this attempt; an uncertain folder is never created twice.
 */
export async function runImportBatch<T extends ImportSource>(
  batch: ImportBatch<T>,
  transport: ImportTransport<T>,
  options: { onProgress?: () => void; shouldStop?: () => boolean } = {},
): Promise<void> {
  if (batch.running) return;
  batch.running = true;
  batch.attempt += 1;
  for (const entry of batch.entries) if (entry.state === "failed") entry.state = "pending";
  options.onProgress?.();

  const folderFor = async (parts: string[]): Promise<{ id: string | null } | { failure: ImportFailure }> => {
    let parentId = batch.parentId;
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      const previous = batch.folders.get(path);
      if (previous && "id" in previous) {
        parentId = previous.id;
        continue;
      }
      if (previous && (!previous.failure.retryable || previous.attempt === batch.attempt)) return previous;
      try {
        const folder = await transport.createFolder(parts[index], parentId);
        if (!folder?.id) throw new Error("The folder was not confirmed by the service.");
        batch.folders.set(path, { id: folder.id });
        parentId = folder.id;
      } catch (error) {
        const result = { failure: transport.describeError(error), attempt: batch.attempt };
        batch.folders.set(path, result);
        return result;
      }
    }
    return { id: parentId };
  };

  try {
    for (const entry of batch.entries) {
      if (options.shouldStop?.()) break;
      if (entry.state !== "pending") continue;
      entry.state = "working";
      entry.error = undefined;
      options.onProgress?.();
      const folder = await folderFor(entry.folders);
      let failure: ImportFailure | undefined;
      if ("failure" in folder) {
        failure = folder.failure;
      } else {
        try {
          const doc = await transport.importFile(entry.file, folder.id);
          if (!doc?.id) throw new Error("The doc was not confirmed by the service.");
          entry.doc = doc;
          entry.state = "done";
        } catch (error) {
          failure = transport.describeError(error);
        }
      }
      if (failure) {
        entry.state = failure.retryable ? "failed" : "uncertain";
        entry.error = failure.message;
      }
      options.onProgress?.();
    }
  } finally {
    batch.running = false;
    options.onProgress?.();
  }
}
