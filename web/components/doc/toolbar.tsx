"use client";

/**
 * The formatting bar, for people who can write or propose changes for review.
 */
import { useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold, CheckSquare, ChevronDown, Code, Highlighter, Image as ImageIcon, Italic, Link as LinkIcon, List, ListOrdered, MessageSquarePlus, Minus, Palette, Plus, Quote, Redo2, Sigma,
  Strikethrough, Superscript, Table as TableIcon, Underline, Undo2, ListTree, Rows3, Columns3, Trash2,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/silicon-ui/popover/popover";
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/silicon-ui/dropdown-menu/dropdown-menu";
import { Tooltip } from "@/components/silicon-ui/tooltip/tooltip";
import styles from "./doc.module.css";

const TEXT_COLOURS = ["#1E1E1C", "#57544D", "#B42318", "#B5531C", "#8F560D", "#2B7148", "#1F5CB1", "#7A4FC4"];
const HIGHLIGHTS = ["#FFF1A8", "#FDE2C8", "#FAD4D0", "#D7F0DC", "#D4E6FB", "#E8DDF7"];

function Tool({ label, active, disabled, onClick, children, shortcut }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; shortcut?: string }) {
  return (
    <Tooltip content={shortcut ? `${label} ${shortcut}` : label}>
      <button type="button" className={styles.tool} aria-label={label} aria-pressed={active} data-active={active ? "" : undefined} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function Toolbar({ editor, canEdit, suggesting, onComment, onImage }: { editor: Editor; canEdit: boolean; suggesting: boolean; onComment?: () => void; onImage: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      table: e.isActive("table"),
      heading: ([1, 2, 3] as const).find(level => e.isActive("heading", { level })) ?? 0,
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      canUndo: e.can().undo?.() ?? true,
      canRedo: e.can().redo?.() ?? true,
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const chain = () => editor.chain().focus();
  const styleLabel = state.heading ? `Heading ${state.heading}` : state.quote ? "Quote" : state.codeBlock ? "Code" : "Text";
  const format = canEdit || suggesting;

  // Formatting menus return the keyboard to the passage being edited. Radix otherwise returns
  // it to the toolbar trigger, where the next space opens the menu instead of entering text.
  const returnToDoc = (event: Event) => {
    event.preventDefault();
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('[role="toolbar"], [data-radix-popper-content-wrapper]')) editor.commands.focus();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!format || !editor.view.hasFocus() || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      event.stopPropagation();
      setHref(editor.getAttributes("link").href ?? "");
      setLinkOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor, format]);

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
      <div className={styles.toolGroup}>
        <Tool label="Undo" shortcut={`${mod}Z`} disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          <Undo2 size={16} />
        </Tool>
        <Tool label="Redo" shortcut={`${mod}⇧Z`} disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          <Redo2 size={16} />
        </Tool>
      </div>
      {format ? (
        <>
          <span className={styles.toolSep} aria-hidden="true" />
          <DropdownMenuRoot>
            <DropdownMenuTrigger asChild>
              <button type="button" className={styles.styleButton} onMouseDown={e => e.preventDefault()} aria-label={`Paragraph style: ${styleLabel}`}>
                {styleLabel} <ChevronDown size={14} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={returnToDoc}>
              <DropdownMenuItem onSelect={() => chain().setParagraph().run()}>Text</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().toggleHeading({ level: 1 }).run()}>Heading 1</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().toggleHeading({ level: 2 }).run()}>Heading 2</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().toggleHeading({ level: 3 }).run()}>Heading 3</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().toggleBlockquote().run()}>Quote</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().toggleCodeBlock().run()}>Code</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
          <span className={styles.toolSep} aria-hidden="true" />
          <div className={styles.toolGroup}>
            <Tool label="Bold" shortcut={`${mod}B`} active={state.bold} onClick={() => chain().toggleBold().run()}>
              <Bold size={16} />
            </Tool>
            <Tool label="Italic" shortcut={`${mod}I`} active={state.italic} onClick={() => chain().toggleItalic().run()}>
              <Italic size={16} />
            </Tool>
            <Tool label="Underline" shortcut={`${mod}U`} active={state.underline} onClick={() => chain().toggleUnderline().run()}>
              <Underline size={16} />
            </Tool>
            <Tool label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}>
              <Strikethrough size={16} />
            </Tool>
            <Tool label="Code" active={state.code} onClick={() => chain().toggleCode().run()}>
              <Code size={16} />
            </Tool>
            <Popover>
              <Tooltip content="Text colour">
                <PopoverTrigger asChild>
                  <button type="button" className={styles.tool} aria-label="Text colour" onMouseDown={e => e.preventDefault()}>
                    <Palette size={16} />
                  </button>
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent className={styles.palette} onCloseAutoFocus={returnToDoc}>
                {TEXT_COLOURS.map(colour => (
                  <button key={colour} type="button" className={styles.swatch} style={{ background: colour }} aria-label={`Colour ${colour}`} onClick={() => chain().setColor(colour).run()} />
                ))}
                <button type="button" className={styles.swatchClear} onClick={() => chain().unsetColor().run()}>
                  Default
                </button>
              </PopoverContent>
            </Popover>
            <Popover>
              <Tooltip content="Highlight">
                <PopoverTrigger asChild>
                  <button type="button" className={styles.tool} aria-label="Highlight" onMouseDown={e => e.preventDefault()}>
                    <Highlighter size={16} />
                  </button>
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent className={styles.palette} onCloseAutoFocus={returnToDoc}>
                {HIGHLIGHTS.map(colour => (
                  <button key={colour} type="button" className={styles.swatch} style={{ background: colour }} aria-label={`Highlight ${colour}`} onClick={() => chain().setHighlight({ color: colour }).run()} />
                ))}
                <button type="button" className={styles.swatchClear} onClick={() => chain().unsetHighlight().run()}>
                  None
                </button>
              </PopoverContent>
            </Popover>
            <Popover
              open={linkOpen}
              onOpenChange={open => {
                setLinkOpen(open);
                if (open) setHref(state.href);
              }}
            >
              <Tooltip content={`Link ${mod}K`}>
                <PopoverTrigger asChild>
                  <button type="button" className={styles.tool} aria-label="Link" data-active={state.link ? "" : undefined} onMouseDown={e => e.preventDefault()}>
                    <LinkIcon size={16} />
                  </button>
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent className={styles.linkPopover} onCloseAutoFocus={returnToDoc}>
                <form
                  onSubmit={e => {
                    e.preventDefault();
                    const value = href.trim();
                    if (!value) chain().extendMarkRange("link").unsetLink().run();
                    else chain().extendMarkRange("link").setLink({ href: /^[a-z]+:/i.test(value) || value.startsWith("/") ? value : `https://${value}` }).run();
                    setLinkOpen(false);
                  }}
                >
                  <input className={styles.linkInput} value={href} onChange={e => setHref(e.target.value)} placeholder="Paste or type a link" aria-label="Link address" autoFocus />
                  <div className={styles.linkActions}>
                    {state.link ? (
                      <button type="button" className={styles.textButton} onClick={() => { chain().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>
                        Remove
                      </button>
                    ) : null}
                    <button type="submit" className={styles.textButtonStrong}>
                      Apply
                    </button>
                  </div>
                </form>
              </PopoverContent>
            </Popover>
          </div>
          <span className={styles.toolSep} aria-hidden="true" />
          <div className={styles.toolGroup}>
            <Tool label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}>
              <List size={16} />
            </Tool>
            <Tool label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
              <ListOrdered size={16} />
            </Tool>
            <Tool label="Checklist" active={state.task} onClick={() => chain().toggleTaskList().run()}>
              <CheckSquare size={16} />
            </Tool>
            <Tool label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()}>
              <Quote size={16} />
            </Tool>
          </div>
          <span className={styles.toolSep} aria-hidden="true" />
          <DropdownMenuRoot>
            <DropdownMenuTrigger asChild>
              <button type="button" className={styles.styleButton} onMouseDown={e => e.preventDefault()}>
                <Plus size={15} aria-hidden="true" /> Insert
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={returnToDoc}>
              <DropdownMenuItem icon={<TableIcon size={16} />} onSelect={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</DropdownMenuItem>
              <DropdownMenuItem icon={<ImageIcon size={16} />} onSelect={onImage}>Image</DropdownMenuItem>
              <DropdownMenuItem icon={<Minus size={16} />} onSelect={() => chain().setHorizontalRule().run()}>Divider</DropdownMenuItem>
              <DropdownMenuItem icon={<Sigma size={16} />} onSelect={() => chain().insertContent({ type: "blockMath", attrs: { latex: "E = mc^2" } }).run()}>Maths block</DropdownMenuItem>
              <DropdownMenuItem icon={<Sigma size={16} />} onSelect={() => chain().insertContent({ type: "inlineMath", attrs: { latex: "x^2" } }).run()}>Inline maths</DropdownMenuItem>
              <DropdownMenuItem icon={<Superscript size={16} />} onSelect={() => chain().insertFootnote("").run()}>Footnote</DropdownMenuItem>
              <DropdownMenuItem icon={<ListTree size={16} />} onSelect={() => chain().insertContent({ type: "tableOfContents" }).run()}>Table of contents</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
          {state.table ? (
            <DropdownMenuRoot>
              <DropdownMenuTrigger asChild>
                <button type="button" className={styles.styleButton} onMouseDown={e => e.preventDefault()}>
                  <TableIcon size={15} aria-hidden="true" /> Table
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onCloseAutoFocus={returnToDoc}>
                <DropdownMenuItem icon={<Rows3 size={16} />} onSelect={() => chain().addRowAfter().run()}>Add a row below</DropdownMenuItem>
                <DropdownMenuItem icon={<Rows3 size={16} />} onSelect={() => chain().addRowBefore().run()}>Add a row above</DropdownMenuItem>
                <DropdownMenuItem icon={<Columns3 size={16} />} onSelect={() => chain().addColumnAfter().run()}>Add a column right</DropdownMenuItem>
                <DropdownMenuItem icon={<Columns3 size={16} />} onSelect={() => chain().addColumnBefore().run()}>Add a column left</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => chain().mergeOrSplit().run()}>Merge or split cells</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => chain().toggleHeaderRow().run()}>Header row on or off</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => chain().deleteRow().run()}>Delete row</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => chain().deleteColumn().run()}>Delete column</DropdownMenuItem>
                <DropdownMenuItem icon={<Trash2 size={16} />} destructive onSelect={() => chain().deleteTable().run()}>Delete table</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuRoot>
          ) : null}
        </>
      ) : null}
      {suggesting ? <p className={styles.suggestNote}>Suggesting: your changes are proposed for review.</p> : null}
      {onComment ? (
        <div className={styles.toolEnd}>
          <Tool label="Comment" shortcut={`${mod}⌥M`} onClick={onComment}>
            <MessageSquarePlus size={16} />
          </Tool>
        </div>
      ) : null}
    </div>
  );
}
