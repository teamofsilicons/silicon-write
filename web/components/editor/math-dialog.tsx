"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import katex from "katex";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import styles from "./math-dialog.module.css";

export interface MathTarget { kind: "inlineMath" | "blockMath"; latex: string; pos: number }

export function MathDialog({ editor, target, onClose }: { editor: Editor; target: MathTarget; onClose: () => void }) {
  const [latex, setLatex] = useState(target.latex);
  const [error, setError] = useState("");
  const position = useRef<number | null>(target.pos);
  useEffect(() => {
    const map = ({ transaction }: { transaction: Transaction }) => {
      if (position.current === null) return;
      const result = transaction.mapping.mapResult(position.current, 1);
      position.current = result.deleted ? null : result.pos;
    };
    editor.on("transaction", map);
    return () => { editor.off("transaction", map); };
  }, [editor]);

  let preview = "";
  let invalid = false;
  if (latex.trim()) {
    try { preview = katex.renderToString(latex, { displayMode: target.kind === "blockMath", throwOnError: true }); }
    catch { invalid = true; }
  }
  const save = () => {
    const pos = position.current;
    const node = pos === null ? null : editor.state.doc.nodeAt(pos);
    if (!editor.isEditable || !node || node.type.name !== target.kind || node.attrs.latex !== target.latex) {
      setError("This equation changed while you were editing it. Close this dialog and try again.");
      return;
    }
    if (pos === null) return;
    // Replace the atom so Suggesting mode can retain the old equation for review.
    editor.chain().focus().insertContentAt({ from: pos, to: pos + node.nodeSize }, { type: target.kind, attrs: { ...node.attrs, latex } }).run();
    onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent title={target.kind === "blockMath" ? "Edit maths block" : "Edit inline maths"} description="Write an equation using LaTeX.">
      <label className={styles.label} htmlFor="math-latex">LaTeX</label>
      <textarea id="math-latex" className={styles.input} value={latex} onChange={event => setLatex(event.target.value)} rows={target.kind === "blockMath" ? 4 : 2} spellCheck={false} autoFocus />
      <div className={styles.preview} aria-label="Equation preview">{preview ? <span dangerouslySetInnerHTML={{ __html: preview }} /> : <span>{invalid ? "Check the LaTeX syntax." : "Your equation will appear here."}</span>}</div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <div className={styles.actions}><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!latex.trim() || invalid} onClick={save}>Save</Button></div>
    </DialogContent>
  </Dialog>;
}
