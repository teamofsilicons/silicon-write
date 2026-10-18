import type { MentionValue } from "@/components/silicon-ui/mention-input/mention-input";
import type { Anchor } from "./types";

export const EMPTY_COMMENT_DRAFT: MentionValue = { text: "", mentions: [] };

/** Use relative positions, not the displayed quote or popover coordinates. */
export function commentAnchorTarget(anchor: Anchor): string {
  const rect = anchor.rect;
  return JSON.stringify([anchor.kind, anchor.start ?? null, anchor.end ?? null,
    rect ? [rect.page ?? null, rect.x, rect.y, rect.w, rect.h] : null]);
}

export function commentDraftKey(account: string, docId: string, target: string): string {
  return `silicon-write:comment-draft:v1:${JSON.stringify([account, docId, target])}`;
}

export function readCommentDraft(raw: string | null): MentionValue {
  if (!raw) return EMPTY_COMMENT_DRAFT;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text !== "string" || !Array.isArray(parsed.mentions)) return EMPTY_COMMENT_DRAFT;
    return { text: parsed.text, mentions: parsed.mentions.filter((m: unknown) => {
      if (!m || typeof m !== "object") return false;
      const mention = m as Record<string, unknown>;
      return (mention.kind === "person" || mention.kind === "channel") && typeof mention.id === "string" &&
        typeof mention.label === "string" && typeof mention.start === "number" && typeof mention.end === "number" &&
        Number.isInteger(mention.start) && Number.isInteger(mention.end) && mention.start >= 0 &&
        mention.end > mention.start && mention.end <= parsed.text.length;
    }) };
  } catch { return EMPTY_COMMENT_DRAFT; }
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Session storage survives reloads; memory remains usable when storage is unavailable. */
export function createCommentDraftStore(storage: () => DraftStorage) {
  const values = new Map<string, MentionValue>();
  const listeners = new Set<() => void>();
  const read = (key: string): MentionValue => {
    if (!values.has(key)) {
      let value = EMPTY_COMMENT_DRAFT;
      try { value = readCommentDraft(storage().getItem(key)); } catch { /* Storage can be disabled. */ }
      values.set(key, value);
    }
    return values.get(key)!;
  };
  const write = (key: string, value: MentionValue) => {
    values.set(key, value);
    try {
      if (value.text) storage().setItem(key, JSON.stringify(value));
      else storage().removeItem(key);
    } catch { /* Keep the in-memory draft if session storage is unavailable or full. */ }
    listeners.forEach(listener => listener());
  };
  return {
    read, write,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear(key: string, expected?: MentionValue): boolean {
      if (expected && JSON.stringify(read(key)) !== JSON.stringify(expected)) return false;
      write(key, EMPTY_COMMENT_DRAFT);
      return true;
    },
  };
}
