/** The service's shapes (docs/api.md, "Shapes"). */

export type AccountKind = "carbon" | "silicon";

export interface Account {
  uuid: string;
  id: string;
  kind: AccountKind;
  display_name: string;
  pfp_url: string;
}

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type PublicAccess = "none" | "view" | "comment" | "edit";

export interface PathPart {
  id: string;
  name: string;
}

export interface Doc {
  id: string;
  title: string;
  kind: "doc" | "pdf";
  owner: Account;
  created_by: Account;
  folder_id: string | null;
  path: PathPart[];
  role: Role;
  public_access: PublicAccess;
  require_email?: boolean;
  seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  archived?: boolean;
  url: string;
}

export interface Folder {
  id: string;
  name: string;
  owner: Account;
  parent_id: string | null;
  path: PathPart[];
  role: Role;
  created_at: string;
  deleted_at: string | null;
  archived?: boolean;
}

export interface Library {
  folder: Folder | null;
  folders: Folder[];
  docs: Doc[];
}

export interface Member {
  id: string;
  account: Account | null;
  email: string | null;
  role: Exclude<Role, "owner">;
  via: "doc" | "folder" | { folder: PathPart | null };
  pending: boolean;
  invited_by: Account | null;
  created_at: string;
}

export interface Sharing {
  owner: Account;
  public_access: PublicAccess;
  require_email?: boolean;
  members: Member[];
  role: Role;
}

export interface Reaction {
  emoji: string;
  accounts: Account[];
}

export interface VoiceRecording {
  id: string;
  duration_ms: number;
  transcript: string | null;
}

export interface Comment {
  voice?: VoiceRecording | null;
  id: string;
  author: Account;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reactions: Reaction[];
}

export interface Anchor {
  kind: "text" | "block" | "cell" | "image" | "pdf";
  start?: string;
  end?: string;
  quote?: string;
  rect?: { x: number; y: number; w: number; h: number; page?: number };
}

export interface Thread {
  id: string;
  anchor: Anchor;
  quote: string;
  current_quote: string | null;
  orphaned: boolean;
  block_index: number | null;
  status: "open" | "resolved";
  created_by: Account;
  created_at: string;
  resolved_by: Account | null;
  resolved_at: string | null;
  comments: Comment[];
  activity_version: number;
  unread: boolean;
}

export interface Suggestion {
  id: string;
  author: Account | null;
  inserted: string;
  deleted: string;
}

export interface Version {
  seq: number;
  from_seq: number;
  authors: Account[];
  summary: string;
  name: string | null;
  origin: string;
  created_at: string;
}

export interface CompareBlock {
  change: "same" | "added" | "removed" | "changed";
  before_index?: number;
  after_index?: number;
  before?: string;
  after?: string;
  by?: Account | Account[] | null;
  parts?: { op: "same" | "added" | "removed"; text: string; by?: Account }[];
}

export interface Transfer {
  id: string;
  item: { kind: "doc" | "folder"; id: string; title: string };
  from: Account;
  to: Account;
  status: "pending" | "accepted" | "declined" | "cancelled";
  created_at: string;
}

export interface LiveTicket {
  url: string;
  ticket: string;
  expires_at: string;
  role: Role;
  account: Account | null;
}

export interface ActivityEvent {
  id: number;
  kind: string;
  actor: Account;
  data: Record<string, unknown>;
  created_at: string;
  undoable: boolean;
  undone_at: string | null;
}

export const roleRank: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
export const atLeast = (role: Role | undefined | null, min: Role) => role != null && roleRank[role] >= roleRank[min];

export function handle(account: Pick<Account, "id" | "display_name"> | null | undefined): string {
  if (!account) return "Someone";
  return account.id || account.display_name || "Someone";
}

export function displayName(account: Pick<Account, "id" | "display_name"> | null | undefined): string {
  if (!account) return "Someone";
  return account.display_name || account.id || "Someone";
}
