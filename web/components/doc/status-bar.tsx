"use client";

/** Quiet document counts and the live connection's actual sync state. */
import { useCallback, useSyncExternalStore } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { LiveDoc } from "@/lib/write/live";
import styles from "./doc.module.css";

export function StatusBar({ editor }: { editor: Editor }) {
  const counts = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const storage = (e.storage as unknown as { characterCount?: { words: () => number; characters: () => number } }).characterCount;
      return { words: storage?.words() ?? 0, characters: storage?.characters() ?? 0 };
    },
  });
  return (
    <footer className={styles.statusBar}>
      <span>{counts.words === 1 ? "1 word" : `${counts.words.toLocaleString()} words`} · {counts.characters.toLocaleString()} characters</span>
    </footer>
  );
}

export function SyncState({ live, error }: { live: LiveDoc | null; error?: string | null }) {
  const subscribe = useCallback((changed: () => void) => {
    if (!live) return () => {};
    live.provider.on("status", changed);
    live.provider.on("sync", changed);
    return () => {
      live.provider.off("status", changed);
      live.provider.off("sync", changed);
    };
  }, [live]);
  const snapshot = useCallback(() => {
    if (error) return "error";
    if (!live || live.provider.wsconnecting) return "connecting";
    if (!live.provider.wsconnected) return "disconnected";
    return live.provider.synced ? "synced" : "connecting";
  }, [live, error]);
  const status = useSyncExternalStore(subscribe, snapshot, () => "connecting");
  const label = status === "synced" ? "Synced" : status === "disconnected" ? "Offline" : status === "error" ? "Couldn't connect" : "Connecting…";
  const detail = status === "synced" ? "Connected and synced" : status === "disconnected" ? "Offline: your changes will be saved when you're back" : error || "Connecting to the doc";
  return <span role="status" aria-label={detail} title={detail} data-status={status} className={styles.saveState}><span className={styles.saveDot} aria-hidden="true" /><span className={styles.saveLabel}>{label}</span></span>;
}
