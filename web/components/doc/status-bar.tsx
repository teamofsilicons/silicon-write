"use client";

/** Word count and whether everything is saved. */
import { useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { LiveDoc } from "@/lib/write/live";
import styles from "./doc.module.css";

export function StatusBar({ editor, live }: { editor: Editor; live: LiveDoc | null }) {
  const counts = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const storage = (e.storage as unknown as { characterCount?: { words: () => number; characters: () => number } }).characterCount;
      return { words: storage?.words() ?? 0, characters: storage?.characters() ?? 0 };
    },
  });
  const [status, setStatus] = useState<"connected" | "connecting" | "disconnected">(() => (live?.provider.wsconnected ? "connected" : "connecting"));
  const [synced, setSynced] = useState(() => Boolean(live?.provider.synced));
  useEffect(() => {
    if (!live) return;
    const onStatus = ({ status: next }: { status: "connected" | "connecting" | "disconnected" }) => setStatus(next);
    const onSync = (value: boolean) => setSynced(value);
    live.provider.on("status", onStatus);
    live.provider.on("sync", onSync);
    return () => {
      live.provider.off("status", onStatus);
      live.provider.off("sync", onSync);
    };
  }, [live]);
  const saved = status === "connected" && synced ? "Every change saved" : status === "disconnected" ? "Offline: your changes will be saved when you're back" : "Connecting…";
  return (
    <footer className={styles.statusBar}>
      <span>{counts.words === 1 ? "1 word" : `${counts.words.toLocaleString()} words`} · {counts.characters.toLocaleString()} characters</span>
      <span data-status={status} className={styles.saveState}>{saved}</span>
    </footer>
  );
}
