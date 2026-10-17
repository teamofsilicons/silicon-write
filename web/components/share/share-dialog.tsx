"use client";

/**
 * Sharing a doc or a folder (UNDERSTANDING.md, "Sharing"): invite Carbons and Silicons by c:id, si:id or email as
 * editor, commenter or viewer; see everyone with access (including through a shared folder); and, for a doc, make it
 * public to anyone with the link. The owner can also transfer it to someone else.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Link2, Mail, UserMinus } from "lucide-react";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Select } from "@/components/silicon-ui/select/select";
import { CopyButton } from "@/components/silicon-ui/copy-button/copy-button";
import { api, seg } from "@/lib/client/api";
import { ApiError } from "@/lib/errors";
import { useSessionView } from "@/lib/client/session";
import { notify, notifyError } from "@/lib/notify";
import { keys, useSharing } from "@/lib/write/queries";
import { displayName, type Member, type PublicAccess } from "@/lib/write/types";
import styles from "./share.module.css";

const ROLES = [
  { value: "editor", label: "Editor" },
  { value: "commenter", label: "Commenter" },
  { value: "viewer", label: "Viewer" },
];

const PUBLIC: { value: PublicAccess; label: string }[] = [
  { value: "none", label: "Only people with access" },
  { value: "view", label: "Anyone with the link can view" },
  { value: "comment", label: "Anyone with the link can comment" },
  { value: "edit", label: "Anyone with the link can edit" },
];

export function ShareDialog({ kind, id, title, open, onOpenChange }: { kind: "docs" | "folders"; id: string; title: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const { data, isLoading, error } = useSharing(kind, id, open);
  // Someone who has the doc only through its public link doesn't see who it's shared with, or share it.
  const linkOnly = error instanceof ApiError && error.status === 403;
  const [to, setTo] = useState("");
  const [role, setRole] = useState("editor");
  const [inviting, setInviting] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const me = useSessionView().account?.uuid;
  const isOwner = data?.role === "owner";
  const canInvite = data?.role === "owner" || data?.role === "editor";
  const refresh = () => {
    client.invalidateQueries({ queryKey: keys.sharing(kind, id) });
    client.invalidateQueries({ queryKey: ["library"] });
    if (kind === "docs") client.invalidateQueries({ queryKey: keys.doc(id) });
  };
  const link = typeof window === "undefined" ? "" : kind === "docs" ? `${window.location.origin}/d/${id}` : `${window.location.origin}/library/${id}`;

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = to.trim();
    if (!target) return;
    setInviting(true);
    try {
      await api.post(`/v1/${kind}/${seg(id)}/sharing`, { to: target, role });
      notify.success(target.includes("@") && !target.startsWith("@") ? `Invited ${target}` : `Shared with ${target}`, target.includes("@") ? "They get access when they sign in with this email." : undefined);
      setTo("");
      refresh();
    } catch (error) {
      notifyError(error, "Couldn't share");
    } finally {
      setInviting(false);
    }
  };

  const change = async (member: Member, next: string) => {
    try {
      await api.patch(`/v1/${kind}/${seg(id)}/sharing/${seg(member.id)}`, { role: next });
      refresh();
    } catch (error) {
      notifyError(error, "Couldn't change the role");
    }
  };

  const remove = async (member: Member) => {
    try {
      await api.delete(`/v1/${kind}/${seg(id)}/sharing/${seg(member.id)}`);
      refresh();
    } catch (error) {
      notifyError(error, "Couldn't remove access");
    }
  };

  const setPublic = async (access: string) => {
    try {
      await api.put(`/v1/docs/${seg(id)}/public`, { access });
      refresh();
    } catch (error) {
      notifyError(error, "Couldn't change who can open the link");
    }
  };

  const transfer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!transferTo.trim()) return;
    try {
      await api.post(`/v1/${kind}/${seg(id)}/transfer`, { to: transferTo.trim() });
      notify.success(`Asked ${transferTo.trim()} to take it over`, "It moves once they accept.");
      setTransferTo("");
    } catch (error) {
      notifyError(error, "Couldn't start the transfer");
    }
  };

  const direct = (data?.members ?? []).filter(m => m.via === "doc" || m.via === "folder");
  const inherited = (data?.members ?? []).filter(m => typeof m.via === "object");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share “${title}”`} description={kind === "folders" ? "Everyone you add can open everything in this folder, now and later." : undefined}>
        <div className={styles.body}>
          {linkOnly ? (
            <>
              <p className={styles.note}>You have this doc through its link. Only its owner and the people it’s shared with can see who has it, or share it.</p>
              <div className={styles.publicHead}>
                <Link2 size={16} aria-hidden="true" />
                <span>The link</span>
                <CopyButton value={link} label="Copy link" />
              </div>
            </>
          ) : null}
          {linkOnly ? null : canInvite ? (
            <form className={styles.invite} onSubmit={invite}>
              <input className={styles.inviteInput} value={to} onChange={e => setTo(e.target.value)} placeholder="c:id, si:id or email" aria-label="Who to share with" autoFocus />
              <Select label="Role" options={ROLES} value={role} onValueChange={setRole} className={styles.roleSelect} />
              <Button type="submit" variant="primary" size="md" loading={inviting} disabled={!to.trim()}>
                Share
              </Button>
            </form>
          ) : (
            <p className={styles.note}>Only the owner and editors can share this.</p>
          )}
          {linkOnly ? null : (
          <ul className={styles.people} aria-label="People with access">
            {data?.owner ? (
              <li className={styles.person}>
                <Avatar name={displayName(data.owner)} src={data.owner.pfp_url || undefined} size="sm" />
                <span className={styles.who}>
                  <span>{displayName(data.owner)}</span>
                  <span className={styles.id}>{data.owner.id}</span>
                </span>
                <span className={styles.role}>Owner</span>
              </li>
            ) : null}
            {isLoading ? <li className={styles.note}>Loading…</li> : null}
            {direct.map(member => (
              <li key={member.id} className={styles.person}>
                {member.account ? <Avatar name={displayName(member.account)} src={member.account.pfp_url || undefined} size="sm" /> : <span className={styles.mailIcon}><Mail size={14} aria-hidden="true" /></span>}
                <span className={styles.who}>
                  <span>{member.account ? displayName(member.account) : member.email}</span>
                  <span className={styles.id}>{member.account ? member.account.id : "Invited, not signed in yet"}</span>
                </span>
                {isOwner ? (
                  <Select label={`Role of ${member.account?.id ?? member.email}`} options={ROLES} value={member.role} onValueChange={v => void change(member, v)} className={styles.roleSelectSmall} />
                ) : (
                  <span className={styles.role}>{member.role[0].toUpperCase() + member.role.slice(1)}</span>
                )}
                {isOwner || (me && member.account?.uuid === me) ? (
                  <button type="button" className={styles.remove} aria-label={member.account?.uuid === me ? "Leave" : `Remove ${member.account?.id ?? member.email}`} onClick={() => void remove(member)}>
                    <UserMinus size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
            {inherited.map(member => (
              <li key={`via-${member.id}`} className={styles.person} data-inherited="">
                {member.account ? <Avatar name={displayName(member.account)} src={member.account.pfp_url || undefined} size="sm" /> : <span className={styles.mailIcon}><Mail size={14} aria-hidden="true" /></span>}
                <span className={styles.who}>
                  <span>{member.account ? displayName(member.account) : member.email}</span>
                  <span className={styles.id}>
                    {member.account?.id ?? member.email} · {typeof member.via === "object" && member.via.folder ? `through the folder “${member.via.folder.name}”` : "through a folder above it"}
                  </span>
                </span>
                <span className={styles.role}>{member.role[0].toUpperCase() + member.role.slice(1)}</span>
              </li>
            ))}
          </ul>
          )}
          {kind === "docs" && !linkOnly ? (
            <section className={styles.public} aria-label="Public link">
              <div className={styles.publicHead}>
                {data?.public_access && data.public_access !== "none" ? <Globe size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
                {isOwner ? (
                  <Select label="Who can open the link" options={PUBLIC} value={data?.public_access ?? "none"} onValueChange={v => void setPublic(v)} className={styles.publicSelect} />
                ) : (
                  <span>{PUBLIC.find(p => p.value === data?.public_access)?.label ?? ""}</span>
                )}
                <CopyButton value={link} label="Copy link" />
              </div>
              <p className={styles.note}>
                {data?.public_access === "none" || !data ? "Nothing is published or listed: a doc only opens for the people above." : "Nothing is published or listed: the doc is just reachable by its link. Commenting or editing through the link needs signing in."}
              </p>
            </section>
          ) : null}
          {isOwner ? (
            <form className={styles.transfer} onSubmit={transfer}>
              <span className={styles.note}>Give it to someone else:</span>
              <input className={styles.inviteInput} value={transferTo} onChange={e => setTransferTo(e.target.value)} placeholder="c:id or si:id" aria-label="Transfer to" />
              <Button type="submit" variant="secondary" size="sm" disabled={!transferTo.trim()}>
                Transfer
              </Button>
            </form>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
