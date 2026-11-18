import { Marked } from "marked";
import { DOMParser as ProseMirrorParser, Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

// Literal HTML in a plain-text clipboard stays text. Rich clipboard content uses the normal paste path.
const markdown = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) =>
      text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
  },
});
const syntax =
  /^(?:#{1,6} |\s*(?:[-*+] |\d+[.)] |> |~~~|```)|\|.+\|)|(?:\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\[[^\]]+\]\([^)]+\)|`[^`]+`)/m;
export function pasteMarkdown(view: EditorView, event: ClipboardEvent) {
  const data = event.clipboardData;
  if (
    !data ||
    !view.editable ||
    view.state.selection.$from.parent.type.spec.code ||
    data.types.includes("text/html")
  )
    return false;
  const text = data.getData("text/markdown") || data.getData("text/plain");
  if (!text || (!data.types.includes("text/markdown") && !syntax.test(text)))
    return false;
  const tree = new DOMParser().parseFromString(
    markdown.parse(text, { async: false }),
    "text/html",
  );
  for (const li of tree.querySelectorAll("li")) {
    const checkbox = li.querySelector(
      ':scope > input[type="checkbox"], :scope > p:first-child > input[type="checkbox"]',
    );
    if (!checkbox) continue;
    li.setAttribute("data-type", "taskItem");
    li.setAttribute("data-checked", String(checkbox.hasAttribute("checked")));
    li.parentElement?.setAttribute("data-type", "taskList");
    checkbox.remove();
  }
  const parser = ProseMirrorParser.fromSchema(view.state.schema);
  const slice =
    tree.body.children.length === 1 &&
    tree.body.firstElementChild?.tagName === "P"
      ? parser.parseSlice(tree.body)
      : new Slice(parser.parse(tree.body).content, 0, 0);
  if (!slice.size) return false;
  view.dispatch(
    view.state.tr
      .replaceSelection(slice)
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste"),
  );
  return true;
}
