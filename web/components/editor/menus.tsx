"use client";

/**
 * Two typing menus, both on Tiptap's suggestion utility:
 * - `/` at the start of a line: insert a block (headings, lists, a table, an image, maths, a footnote…).
 * - `[[`: link to another doc by its title (the docs the reader can open).
 */
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import {
  CheckSquare, Code2, FileText, Heading1, Heading2, Heading3, Image as ImageIcon, List, ListOrdered, ListTree, Minus, Quote, Sigma, Superscript, Table as TableIcon, Text,
} from "lucide-react";
import { api } from "@/lib/client/api";
import styles from "./editor.module.css";

export interface MenuItem {
  title: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string[];
  run: (editor: Editor, range: Range) => void;
}

interface MenuListProps {
  items: MenuItem[];
  command: (item: MenuItem) => void;
  empty: string;
}

export interface MenuListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const MenuList = forwardRef<MenuListHandle, MenuListProps>(function MenuList({ items, command, empty }, ref) {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = list.current;
    const item = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !item) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
  }, [selected]);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowDown") {
        setSelected(s => (s + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected(s => (s - 1 + items.length) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));
  return (
    <div ref={list} data-sq="container" className={styles.menu} role="listbox" aria-label="Insert">
      {items.length === 0 ? <p className={styles.menuEmpty}>{empty}</p> : null}
      {items.map((item, index) => (
        <button
          key={`${item.title}-${index}`}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={styles.menuItem}
          data-selected={index === selected ? "" : undefined}
          onMouseEnter={() => setSelected(index)}
          onMouseDown={e => {
            e.preventDefault();
            command(item);
          }}
        >
          <span className={styles.menuIcon} aria-hidden="true">{item.icon}</span>
          <span className={styles.menuText}>
            <span>{item.title}</span>
            {item.hint ? <span className={styles.menuHint}>{item.hint}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
});

/** Renders a suggestion's menu next to the text being typed. */
function popupRenderer(empty: string, key: PluginKey) {
  return () => {
    let component: ReactRenderer<MenuListHandle, MenuListProps> | null = null;
    let host: HTMLDivElement | null = null;
    let current: SuggestionProps<MenuItem> | null = null;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    const place = () => {
      const rect = current?.clientRect?.();
      const menu = host?.firstElementChild as HTMLElement | null;
      if (!rect || !host || !menu) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const bottom = top + height;
      // Keep the menu attached to the text, never floating over unrelated content.
      host.hidden = rect.bottom < top || rect.top > bottom;
      const below = bottom - rect.bottom - 14;
      const above = rect.top - top - 14;
      const upwards = below < Math.min(340, menu.scrollHeight) && above > below;
      menu.style.maxHeight = `${Math.max(0, Math.min(340, upwards ? above : below))}px`;
      menu.style.width = `${Math.min(284, width - 16)}px`;
      host.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - menu.offsetWidth - 8))}px`;
      host.style.top = `${upwards ? rect.top - menu.offsetHeight - 6 : rect.bottom + 6}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const scroll = (event: Event) => {
      if (host?.contains(event.target as Node)) return;
      schedule();
    };
    const outside = (event: PointerEvent) => {
      if (!host?.contains(event.target as Node) && current) exitSuggestion(current.editor.view, key);
    };
    const cleanup = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      document.removeEventListener("pointerdown", outside, true);
      host?.remove();
      component?.destroy();
      host = null;
      component = null;
      current = null;
    };
    return {
      onStart: (props: SuggestionProps<MenuItem>) => {
        current = props;
        component = new ReactRenderer(MenuList, { props: { items: props.items, command: props.command, empty }, editor: props.editor });
        host = document.createElement("div");
        host.style.position = "fixed";
        host.style.zIndex = "60";
        host.appendChild(component.element);
        document.body.appendChild(host);
        observer = new ResizeObserver(schedule);
        observer.observe(component.element);
        window.addEventListener("scroll", scroll, true);
        window.addEventListener("resize", schedule);
        window.visualViewport?.addEventListener("resize", schedule);
        window.visualViewport?.addEventListener("scroll", schedule);
        document.addEventListener("pointerdown", outside, true);
        place();
        schedule();
      },
      onUpdate: (props: SuggestionProps<MenuItem>) => {
        current = props;
        component?.updateProps({ items: props.items, command: props.command, empty });
        schedule();
      },
      onKeyDown: (props: SuggestionKeyDownProps) => {
        if (props.event.key === "Escape") {
          if (current) exitSuggestion(current.editor.view, key);
          return true;
        }
        return component?.ref?.onKeyDown(props) ?? false;
      },
      onExit: cleanup,
    };
  };
}

export interface BlockActions {
  insertImage: () => void;
}

export function blockItems(actions: BlockActions): MenuItem[] {
  return [
    { title: "Text", icon: <Text size={16} />, keywords: ["paragraph", "normal"], run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { title: "Heading 1", hint: "#", icon: <Heading1 size={16} />, keywords: ["title", "h1"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
    { title: "Heading 2", hint: "##", icon: <Heading2 size={16} />, keywords: ["h2", "section"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
    { title: "Heading 3", hint: "###", icon: <Heading3 size={16} />, keywords: ["h3"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
    { title: "Bulleted list", hint: "-", icon: <List size={16} />, keywords: ["ul", "bullets"], run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { title: "Numbered list", hint: "1.", icon: <ListOrdered size={16} />, keywords: ["ol", "numbers"], run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { title: "Checklist", hint: "[ ]", icon: <CheckSquare size={16} />, keywords: ["todo", "task"], run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { title: "Quote", hint: ">", icon: <Quote size={16} />, keywords: ["blockquote"], run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { title: "Code", hint: "```", icon: <Code2 size={16} />, keywords: ["code block", "snippet"], run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { title: "Table", icon: <TableIcon size={16} />, keywords: ["grid", "rows"], run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: "Image", icon: <ImageIcon size={16} />, keywords: ["picture", "photo"], run: (e, r) => { e.chain().focus().deleteRange(r).run(); actions.insertImage(); } },
    { title: "Divider", hint: "---", icon: <Minus size={16} />, keywords: ["rule", "hr", "line"], run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    { title: "Maths", hint: "$$", icon: <Sigma size={16} />, keywords: ["latex", "equation", "formula"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: "blockMath", attrs: { latex: "E = mc^2" } }).run() },
    { title: "Footnote", icon: <Superscript size={16} />, keywords: ["note", "reference"], run: (e, r) => e.chain().focus().deleteRange(r).insertFootnote("").run() },
    { title: "Table of contents", icon: <ListTree size={16} />, keywords: ["toc", "outline"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: "tableOfContents" }).run() },
    { title: "Link to a doc", hint: "[[", icon: <FileText size={16} />, keywords: ["wiki", "link", "doc"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
  ];
}

const slashKey = new PluginKey("slash-menu");
const docLinkKey = new PluginKey("doc-link-menu");

export const SlashMenu = Extension.create<{ actions: BlockActions }>({
  name: "slashMenu",
  addOptions() {
    return { actions: { insertImage: () => {} } };
  },
  addProseMirrorPlugins() {
    const items = blockItems(this.options.actions);
    return [
      Suggestion<MenuItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: "/",
        startOfLine: true,
        allowSpaces: false,
        items: ({ query }) => {
          const q = query.toLowerCase();
          return items.filter(i => !q || i.title.toLowerCase().includes(q) || i.keywords?.some(k => k.includes(q)));
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popupRenderer("Nothing matches.", slashKey),
      }),
    ];
  },
});

let docTitles: { at: number; titles: string[] } | null = null;

async function titles(): Promise<string[]> {
  if (docTitles && Date.now() - docTitles.at < 30_000) return docTitles.titles;
  try {
    const result = await api.get<{ docs: { title: string }[] }>("/v1/docs");
    docTitles = { at: Date.now(), titles: [...new Set(result.docs.map(d => d.title))] };
  } catch {
    docTitles = { at: Date.now(), titles: [] };
  }
  return docTitles.titles;
}

export const DocLinkMenu = Extension.create({
  name: "docLinkMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion<MenuItem>({
        editor: this.editor,
        pluginKey: docLinkKey,
        char: "[[",
        allowSpaces: true,
        items: async ({ query }) => {
          const q = query.toLowerCase();
          const list = (await titles()).filter(t => !q || t.toLowerCase().includes(q)).slice(0, 8);
          const items: MenuItem[] = list.map(title => ({
            title,
            icon: <FileText size={16} />,
            run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: "docLink", attrs: { title } }).insertContent(" ").run(),
          }));
          if (query.trim() && !list.some(t => t.toLowerCase() === q)) {
            items.push({ title: `Link to “${query.trim()}”`, hint: "a doc with this title", icon: <FileText size={16} />, run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: "docLink", attrs: { title: query.trim() } }).insertContent(" ").run() });
          }
          return items;
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popupRenderer("Type a doc's title.", docLinkKey),
      }),
    ];
  },
});
