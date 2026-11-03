import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeViewRenderer } from "@tiptap/core";
import type { NodeView } from "@tiptap/pm/view";
import katex from "katex";
import { notify } from "@/lib/notify";

const positions = new WeakMap<Element, () => number | undefined>();
export function mathPosition(element: Element): number | undefined { return positions.get(element)?.(); }

/** Keep the LaTeX draft in the node until leaving it; one replacement preserves suggestion history. */
const mathView: NodeViewRenderer = ({ editor, node: initial, getPos }) => {
  let node = initial;
  let original = "";
  let input: HTMLTextAreaElement | null = null;
  const block = node.type.name === "blockMath";
  const wrapper: HTMLElement = document.createElement(block ? "div" : "span");
  wrapper.className = "write-math";
  wrapper.dataset.type = block ? "block-math" : "inline-math";
  wrapper.contentEditable = "false";
  positions.set(wrapper, getPos);

  const render = () => {
    wrapper.dataset.latex = String(node.attrs.latex ?? "");
    wrapper.replaceChildren();
    try { katex.render(String(node.attrs.latex ?? ""), wrapper, { displayMode: block, throwOnError: true }); }
    catch { wrapper.textContent = String(node.attrs.latex ?? ""); }
    wrapper.title = editor.isEditable ? "Click to edit LaTeX" : "";
  };
  const finish = (cancel = false) => {
    if (!input) return;
    const draft = input.value;
    if (!cancel && editor.isEditable && draft !== original) {
      const pos = getPos();
      const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
      if (!current || current.type !== node.type || current.attrs.latex !== original) {
        notify.warning("This equation changed while you were editing it", "Copy your LaTeX or press Escape, then open the equation again.");
        return;
      }
      input = null;
      editor.chain().insertContentAt({ from: pos!, to: pos! + current.nodeSize }, { type: current.type.name, attrs: { ...current.attrs, latex: draft }, marks: current.marks.map(mark => mark.toJSON()) }).run();
    } else {
      input = null;
      render();
    }
  };
  const activate = () => {
    if (!editor.isEditable || input) return;
    original = String(node.attrs.latex ?? "");
    input = document.createElement("textarea");
    input.className = block ? "write-math-input write-math-input-block" : "write-math-input write-math-input-inline";
    input.setAttribute("aria-label", block ? "Maths block LaTeX" : "Inline maths LaTeX");
    input.value = original;
    input.rows = block ? Math.max(1, original.split("\n").length) : 1;
    input.spellcheck = false;
    wrapper.replaceChildren(input);
    input.addEventListener("input", () => { if (input && block) input.rows = Math.max(1, input.value.split("\n").length); });
    input.addEventListener("blur", () => finish());
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); finish(true); editor.view.focus(); }
      else if (event.key === "Enter" && (!block || event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(); editor.view.focus(); }
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  wrapper.addEventListener("click", event => { if (event.button === 0) activate(); });
  render();
  return {
    dom: wrapper,
    stopEvent: (event: Event) => Boolean(input && event.target === input),
    update: (updated: PMNode) => {
      if (updated.type !== node.type) return false;
      node = updated;
      if (!input) render();
      return true;
    },
  } satisfies NodeView;
};

export const EditableInlineMath = InlineMath.extend({ addNodeView() { return mathView; } });
export const EditableBlockMath = BlockMath.extend({ addNodeView() { return mathView; } });
