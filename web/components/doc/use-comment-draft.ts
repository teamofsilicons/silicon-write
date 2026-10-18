"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { MentionValue } from "@/components/silicon-ui/mention-input/mention-input";
import { commentDraftKey, createCommentDraftStore, EMPTY_COMMENT_DRAFT } from "@/lib/write/comment-drafts";

const drafts = createCommentDraftStore(() => window.sessionStorage);
const serverSnapshot = () => EMPTY_COMMENT_DRAFT;

/** A draft belongs to this account, document and passage/thread within this browser session. */
export function useCommentDraft(accountId: string | null, docId: string, target: string | null) {
  const key = accountId && target ? commentDraftKey(accountId, docId, target) : null;
  const snapshot = useCallback(() => key ? drafts.read(key) : EMPTY_COMMENT_DRAFT, [key]);
  const value = useSyncExternalStore(drafts.subscribe, snapshot, serverSnapshot);
  const setValue = useCallback((next: MentionValue) => { if (key) drafts.write(key, next); }, [key]);
  const clear = useCallback((expected?: MentionValue) => key ? drafts.clear(key, expected) : false, [key]);
  return { value, setValue, clear };
}
