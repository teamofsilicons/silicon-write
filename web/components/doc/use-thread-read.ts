"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, seg } from "@/lib/client/api";
import type { Thread } from "@/lib/write/types";

/** Reading follows the rendered conversation, including replies, at one observed revision. */
export function useThreadRead(docId: string, thread: Thread, card: RefObject<HTMLDivElement | null>) {
  const client = useQueryClient();
  const progress = useRef<{ id: string; version: number; seen: Set<string> }>({ id: "", version: 0, seen: new Set() });
  useEffect(() => {
    if (!thread.unread || !thread.activity_version || !thread.comments.length || !card.current) return;
    if (progress.current.id !== thread.id || progress.current.version !== thread.activity_version) {
      progress.current = { id: thread.id, version: thread.activity_version, seen: new Set() };
    }
    const seen = progress.current.seen;
    const element = card.current;
    const panel = element.closest("[data-comment-scroll], aside");
    const visibleSince = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let completed = false;
    const visible = (article: HTMLElement | null) => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
      if (!article || !article.getClientRects().length || article.closest("[inert], [hidden], [aria-hidden='true']")) return false;
      const rect = article.getBoundingClientRect();
      const bounds = panel?.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const top = Math.max(bounds?.top ?? viewportTop, viewportTop);
      const bottom = Math.min(bounds?.bottom ?? window.innerHeight, viewportTop + (viewport?.height ?? window.innerHeight));
      const left = Math.max(rect.left, bounds?.left ?? viewportLeft, viewportLeft);
      const right = Math.min(rect.right, bounds?.right ?? window.innerWidth, viewportLeft + (viewport?.width ?? window.innerWidth));
      // For a long comment, reaching its end counts; a clipped footer alone does not.
      // Short comments must fit entirely in the visible panel.
      const visibleTop = Math.max(rect.top, top);
      if (right <= left || rect.bottom > bottom || rect.bottom - visibleTop < Math.min(rect.height, 48)) return false;
      if (rect.height <= bottom - top && rect.top < top) return false;
      const hit = document.elementFromPoint((left + right) / 2, (visibleTop + rect.bottom) / 2);
      return !!hit && article.contains(hit);
    };
    const acknowledge = async () => {
      pending = true;
      try {
        const result = await api.post<{ activity_version: number; unread: boolean }>(`/v1/threads/${seg(thread.id)}/read`, { activity_version: thread.activity_version });
        completed = true;
        client.setQueriesData<{ threads: Thread[] }>({ queryKey: ["threads", docId] }, current => current && ({
          ...current,
          threads: current.threads.map(item => item.id === thread.id && item.activity_version === thread.activity_version
            ? { ...item, unread: result.unread } : item),
        }));
        if (result.activity_version !== thread.activity_version) void client.invalidateQueries({ queryKey: ["threads", docId] });
      } catch {
        // Preserve unread state; a later focus, scroll or refresh retries the acknowledgement.
      } finally {
        pending = false;
      }
    };
    const check = () => {
      clearTimeout(timer);
      if (pending || completed) return;
      const now = performance.now();
      let nextCheck = Infinity;
      for (const comment of thread.comments) {
        if (seen.has(comment.id)) continue;
        const article = element.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(comment.id)}"]`);
        if (!visible(article)) {
          visibleSince.delete(comment.id);
          continue;
        }
        const since = visibleSince.get(comment.id) ?? now;
        visibleSince.set(comment.id, since);
        const remaining = 600 - (now - since);
        if (remaining <= 0) seen.add(comment.id);
        else nextCheck = Math.min(nextCheck, remaining);
      }
      if (thread.comments.every(comment => seen.has(comment.id))) {
        if (document.visibilityState === "visible" && document.hasFocus()) void acknowledge();
      } else if (Number.isFinite(nextCheck)) timer = setTimeout(check, nextCheck + 10);
    };
    const observer = new MutationObserver(check);
    observer.observe(element, { childList: true, subtree: true });
    const resize = new ResizeObserver(check);
    resize.observe(element);
    window.addEventListener("scroll", check, true);
    window.addEventListener("focus", check);
    window.addEventListener("blur", check);
    window.addEventListener("resize", check);
    document.addEventListener("focusin", check);
    document.addEventListener("visibilitychange", check);
    window.visualViewport?.addEventListener("resize", check);
    window.visualViewport?.addEventListener("scroll", check);
    check();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", check, true);
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", check);
      window.removeEventListener("resize", check);
      document.removeEventListener("focusin", check);
      document.removeEventListener("visibilitychange", check);
      window.visualViewport?.removeEventListener("resize", check);
      window.visualViewport?.removeEventListener("scroll", check);
    };
  }, [client, docId, thread, card]);
}
