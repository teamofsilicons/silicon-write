"use client";

import { useMemo } from "react";
import { getSchema } from "@tiptap/core";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { contentExtensions } from "./schema";
import styles from "./editor.module.css";

/** Read-only until the server's document arrives. Cached content is never sent to Yjs. */
export function CachedContent({ content }: { content: JSONContent }) {
  const extensions = useMemo(() => contentExtensions({ collaborative: false }), []);
  const checked = useMemo(() => {
    try { getSchema(extensions).nodeFromJSON(content).check(); return content; }
    catch { return undefined; } // A damaged cache must not prevent the live document opening.
  }, [content, extensions]);
  const editor = useEditor({
    extensions,
    content: checked,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: styles.prose, "aria-label": "Saved document preview" } },
  }, [content]);
  return <EditorContent editor={editor} className={styles.editor} data-cached-content="true" />;
}
