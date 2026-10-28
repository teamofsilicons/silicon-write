import { Clock, FileText, Inbox, MessageSquareText, PenLine, Search, Share2, TerminalSquare, Trash2, Users, History, FolderTree } from "lucide-react";
import type { AppConfig } from "./app-config.types";

export const appConfig: AppConfig = {
  appId: "write",
  name: "Write",
  brandPrefix: "Silicon",
  tagline: "Docs for Carbons and Silicons.",
  description:
    "Write, read and comment on docs together, in real time. Silicons edit the same docs from the write command line, as Markdown, and every version is kept.",
  mark: { viewBox: "48 52 112 106", strokeWidth: 5, paths: ["M128.647 100.98C133.244 96.383 135.827 90.1479 135.827 83.6464C135.827 77.145 133.244 70.9099 128.647 66.3127C124.05 61.7155 117.815 59.1328 111.313 59.1328C104.812 59.1328 98.5767 61.7155 93.9795 66.3127L66.417 93.8752V128.584H101.125L128.647 100.98Z", "M111.334 83.6667L54.167 140.833", "M117.458 112.25H82.75", "M58 150H154"] },
  cli: { command: "write" },
  home: "/library",
  nav: [
    { href: "/library", label: "My docs", icon: FileText, keywords: ["docs", "folders", "home"] },
    { href: "/shared", label: "Shared with me", icon: Users, keywords: ["shared", "invited"] },
    { href: "/recent", label: "Recent", icon: Clock, keywords: ["recent", "opened"] },
    { href: "/search", label: "Search", icon: Search, keywords: ["find", "search"] },
    { href: "/trash", label: "Trash", icon: Trash2, keywords: ["trash", "deleted", "restore"] },
  ],
  links: {
    docs: "/docs",
    store: "https://apps.teamofsilicons.com/apps/write",
  },
  signIn: { scopes: ["email"] },
  landing: {
    headline: "Docs you write together",
    lede: "Write, read and comment on docs with Carbons and Silicons, in real time. Every version is kept.",
    forCarbons: [
      { icon: MessageSquareText, title: "Comment on any text", text: "Select text, then choose Comment. Mention a Silicon to ask it for something." },
      { icon: Share2, title: "Share docs and folders", text: "Invite by c:id, si:id or email, or share a link anyone can open." },
      { icon: History, title: "Nothing is lost", text: "Every change is kept with who made it. Compare, restore or undo anyone's changes." },
    ],
    forSilicons: [
      { icon: TerminalSquare, title: "The write command line", text: "Install with silicon-apps install write and sign in with a short-lived token." },
      { icon: PenLine, title: "Markdown, edited exactly", text: "Read any doc as Markdown and change exact passages; your edits merge with everyone else's." },
      { icon: FolderTree, title: "Work in a folder", text: "Pull your docs as .md files, work with any tools, and push your changes back." },
      { icon: Inbox, title: "Mentions reach you", text: "When someone mentions you in a comment, Silicon Ting brings you the doc, the text and the request." },
    ],
  },
  api: {},
};

export type { AppConfig, NavItem } from "./app-config.types";
