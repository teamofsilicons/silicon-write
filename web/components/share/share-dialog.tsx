"use client";

/**
 * Sharing a doc or a folder (UNDERSTANDING.md, "Sharing"): invite Carbons and Silicons by c:id, si:id or email as
 * editor, commenter or viewer; see everyone with access (including through a shared folder); and, for a doc, make it
 * public to anyone with the link. The owner can also transfer it to someone else.
 */
import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Globe, Link2, LockKeyhole, Mail, UserMinus, Users } from "lucide-react";
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
import { Recipient } from "./recipient";
import { ContactsButton } from "./contacts";
import { selectedPerson, mergePeople, photo, usePeople, useOrganizations, type Group, type OrgSettings } from "@/lib/write/people";

const ROLES = [
  { value: "editor", label: "Editor" },
  { value: "commenter", label: "Suggester" },
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
  const inviteId = useId();
  const { data, isLoading, error } = useSharing(kind, id, open);
  // Someone who has the doc only through its public link doesn't see who it's shared with, or share it.
  const linkOnly = error instanceof ApiError && error.status === 403;
  const [to, setTo] = useState("");
  const [role, setRole] = useState("editor");
  const [inviting, setInviting] = useState(false);
  const [savingLink, setSavingLink] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<boolean | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const me = useSessionView().account?.uuid;
  const isOwner = data?.role === "owner";
  const canInvite = data?.role === "owner" || data?.role === "editor";
  const directory = usePeople(open && !linkOnly);
  const orgs = useOrganizations(open && canInvite);
  const people = mergePeople(directory.data?.items ?? [], [data?.owner,...(data?.members ?? []).map(m=>m.account)]);
  const personal = (a: NonNullable<Member["account"]>) => people.find(p=>p.uuid===a.uuid) ?? a;
  const [groupRole,setGroupRole] = useState<{key:string;org:string} | null>(null);
  const defaults = useQuery({queryKey:["write-org-settings",me,groupRole?.org],enabled:!!groupRole && open,
    queryFn:({signal})=>api.get<OrgSettings>(`/v1/organizations/${seg(groupRole!.org)}/settings`,{signal})});
  const chooseGroup = (g: Group) => setGroupRole({key:`${g.type}:${g.id}`,org:g.org_id});
  const selectedRole = groupRole && groupRole.key === to ? defaults.data?.default_role ?? "viewer" : role;
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: keys.sharing(kind, id) }),
    client.invalidateQueries({ queryKey: ["library"] }),
    ...(kind === "docs" ? [client.invalidateQueries({ queryKey: keys.doc(id) })] : []),
  ]);
  const link = typeof window === "undefined" ? "" : kind === "docs" ? `${window.location.origin}/d/${id}` : `${window.location.origin}/library/${id}`;

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = selectedPerson(to, people)?.id ?? to.trim();
    if (!target) return;
    setInviting(true);
    try {
      await api.post(`/v1/${kind}/${seg(id)}/sharing`, { to: target, role: selectedRole });
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

  const setPublic = async (access: string, requireEmail = data?.require_email ?? false) => {
    setSavingLink(true);
    setPendingEmail(requireEmail);
    try {
      await api.put(`/v1/docs/${seg(id)}/public`, { access, require_email: requireEmail });
      await refresh();
    } catch (error) {
      notifyError(error, "Couldn't change who can open the link");
    } finally {
      setSavingLink(false);
      setPendingEmail(null);
    }
  };

  const transfer = async (event: React.FormEvent) => {
    event.preventDefault();
    const recipient = selectedPerson(transferTo, people)?.id ?? transferTo.trim();
    if (!recipient) return;
    try {
      await api.post(`/v1/${kind}/${seg(id)}/transfer`, { to: recipient });
      notify.success(`Asked ${recipient} to take it over`, "It moves once they accept.");
      setTransferTo("");
    } catch (error) {
      notifyError(error, "Couldn't start the transfer");
    }
  };

  const direct = (data?.members ?? []).filter(m => m.via === "doc" || m.via === "folder");
  const inherited = (data?.members ?? []).filter(m => typeof m.via === "object");
  const publicAccess = data?.public_access ?? "none";
  const linkDescription = publicAccess === "none"
    ? "Only people with access can open this link."
    : publicAccess === "view"
      ? "Anyone with the link can read. It isn’t listed publicly."
      : "Anyone with the link can " + (publicAccess === "comment" ? "comment" : "edit") + " after signing in. It isn’t listed publicly.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Share" description={title} className={styles.dialog}>
        <div className={styles.body}>
          {kind === "folders" && data ? <p className={styles.note}>Everyone you add can open everything in this folder, now and later.</p> : null}
          {linkOnly ? (
            <p className={styles.note}>You have this doc through its link. Only its owner and the people it’s shared with can see who has it, or share it.</p>
          ) : canInvite ? (
            <form className={styles.invite} onSubmit={invite}>
              <label htmlFor={inviteId} className={styles.sectionLabel}>Who to share with</label>
              <div className={styles.inviteRow}>
                <Recipient id={inviteId} label="Who to share with" value={to} onChange={v=>{setTo(v); setGroupRole(null);}} onGroup={chooseGroup} autoFocus
                  placeholder="Name, ID, team or email" people={people} groups={orgs.data?.share_targets}/>
                <div className={styles.roleField}>
                  <Select label="Role" options={ROLES} value={selectedRole} onValueChange={v=>{setGroupRole(null); setRole(v);}} className={styles.roleSelect} />
                </div>
                <Button type="submit" variant="primary" size="md" loading={inviting} disabled={!to.trim() || (!!groupRole && !defaults.data)} className={styles.shareButton}>
                  Share
                </Button>
              </div>
              {selectedRole === "commenter" ? <p className={styles.note}>Can comment and suggest changes. Editors accept or reject them.</p> : null}
            </form>
          ) : data ? (
            <p className={styles.note}>Only the owner and editors can share this.</p>
          ) : null}
          {canInvite && <div><ContactsButton/>{directory.data?.status === "unavailable" && <span role="status"> Saved contacts are temporarily unavailable.</span>}</div>}
          {isLoading ? <p className={styles.note} role="status">Loading access…</p> : null}
          {error && !linkOnly ? <p className={styles.note} role="alert">Couldn’t load sharing. Close this dialog and try again.</p> : null}
          {data && !linkOnly ? (
            <section className={styles.access} aria-label="People">
              <h3 className={styles.sectionLabel}>People with access</h3>
              <ul className={styles.people} aria-label="People with access">
                {data.owner ? (
                  <li className={styles.person}>
                    <Avatar name={displayName(personal(data.owner))} src={photo(personal(data.owner))} size="sm" />
                    <span className={styles.who}>
                      <span>{displayName(personal(data.owner))}</span>
                      <span className={styles.id}>{data.owner.id}</span>
                    </span>
                    <span className={styles.role}>Owner</span>
                  </li>
                ) : null}
                {direct.map(member => (
                  <li key={member.id} className={styles.person}>
                    {member.account ? <Avatar name={displayName(personal(member.account))} src={photo(personal(member.account))} size="sm" /> : <span className={styles.mailIcon}>{member.group ? <Users size={14}/> : <Mail size={14} aria-hidden="true"/>}</span>}
                    <span className={styles.who}>
                      <span>{member.account ? displayName(personal(member.account)) : member.group?.name ?? member.email}</span>
                      <span className={styles.id}>{member.account ? member.account.id : member.group?.key ?? "Invited, not signed in yet"}</span>
                    </span>
                    <div className={styles.memberActions}>
                      {isOwner ? (
                        <div className={styles.roleField}>
                          <Select label={`Role of ${member.account?.id ?? member.group?.key ?? member.email}`} options={ROLES} value={member.role} onValueChange={v => void change(member, v)} className={styles.roleSelectSmall} />
                        </div>
                      ) : (
                        <span className={styles.role}>{member.role === "commenter" ? "Suggester" : member.role[0].toUpperCase() + member.role.slice(1)}</span>
                      )}
                      {isOwner || (me && member.account?.uuid === me) ? (
                        <button type="button" className={styles.remove} aria-label={member.account?.uuid === me ? "Leave" : `Remove ${member.account?.id ?? member.group?.key ?? member.email}`} onClick={() => void remove(member)}>
                          <UserMinus size={15} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
                {inherited.map(member => (
                  <li key={`via-${member.id}`} className={styles.person}>
                    {member.account ? <Avatar name={displayName(personal(member.account))} src={photo(personal(member.account))} size="sm" /> : <span className={styles.mailIcon}>{member.group ? <Users size={14}/> : <Mail size={14} aria-hidden="true"/>}</span>}
                    <span className={styles.who}>
                      <span>{member.account ? displayName(personal(member.account)) : member.group?.name ?? member.email}</span>
                      <span className={styles.id}>
                        {member.account?.id ?? member.group?.key ?? member.email} · {typeof member.via === "object" && member.via.folder ? `through the folder “${member.via.folder.name}”` : "through a folder above it"}
                      </span>
                    </span>
                    <span className={styles.role}>{member.role === "commenter" ? "Suggester" : member.role[0].toUpperCase() + member.role.slice(1)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data || linkOnly ? (
            <section className={styles.public} aria-label={kind === "docs" ? "Public link" : "Folder link"}>
              <div className={styles.publicHead}>
                <h3 className={styles.sectionLabel}>{linkOnly ? "The link" : "Link access"}</h3>
                <CopyButton value={link} label="Copy link" variant="plain" />
              </div>
              {kind === "docs" && !linkOnly ? (
                <>
                  <div className={styles.linkAccess}>
                    <span className={styles.accessIcon}>
                      {publicAccess !== "none" ? <Globe size={18} aria-hidden="true" /> : <LockKeyhole size={18} aria-hidden="true" />}
                    </span>
                    {isOwner ? (
                      <div className={styles.roleField}>
                        <Select label="Who can open the link" disabled={savingLink} options={PUBLIC} value={publicAccess} onValueChange={v => void setPublic(v)} className={styles.publicSelect} />
                      </div>
                    ) : <span className={styles.linkLabel}>{PUBLIC.find(p => p.value === publicAccess)?.label}</span>}
                  </div>
                  <p className={styles.note}>{linkDescription}</p>
                  {isOwner && publicAccess !== "none" ? <div className={styles.emailSetting}>
                    <label><input type="checkbox" checked={pendingEmail ?? data?.require_email ?? false} disabled={savingLink} onChange={event => void setPublic(publicAccess, event.target.checked)} /> Require email to view</label>
                    <p className={styles.note}>Signed-in visitors use their account email. Others enter an unverified email without signing in. Only you can see the viewer list.</p>
                  </div> : null}
                </>
              ) : kind === "folders" ? (
                <p className={styles.note}><Link2 size={14} aria-hidden="true" /> Only people with access can open this folder.</p>
              ) : null}
            </section>
          ) : null}
          {isOwner && kind === "docs" && open ? <ViewerList docId={id} /> : null}
          {isOwner ? (
            <details className={styles.transfer}>
              <summary><ChevronRight size={14} aria-hidden="true" /> Transfer ownership</summary>
              <div className={styles.transferBody}>
                <p className={styles.note}>They must accept before ownership changes.</p>
                <form className={styles.transferForm} onSubmit={transfer}>
                  <Recipient label="Transfer to" value={transferTo} onChange={setTransferTo} people={people} placeholder="c:id or si:id" />
                  <Button type="submit" variant="secondary" size="sm" disabled={!transferTo.trim()}>Transfer</Button>
                </form>
              </div>
            </details>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}


type ViewerPage = { viewers: { email: string; email_source: "account" | "entered"; first_viewed_at: string; last_viewed_at: string }[]; total: number; next_offset: number | null };
function ViewerList({ docId }: { docId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["doc-viewers", docId, offset],
    queryFn: () => api.get<ViewerPage>(`/v1/docs/${seg(docId)}/viewers?offset=${offset}`),
    enabled: expanded,
    staleTime: 0,
  });
  const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return <details className={styles.transfer} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><ChevronRight size={14} aria-hidden="true" /> Viewers{data ? ` (${data.total})` : ""}</summary>
    <div className={styles.transferBody}>
      <p className={styles.note}>Visits are recorded while “Require email to view” is enabled. Repeat visits are grouped by account or entered email. Your own visits aren’t included.</p>
      <div className={styles.publicHead}><span className={styles.sectionLabel}>Viewer history</span><Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>Refresh viewers</Button></div>
      {error ? <p role="alert" className={styles.note}>Couldn’t load viewers. Try refreshing.</p> : null}
      {isFetching && !data ? <p role="status" className={styles.note}>Loading viewers…</p> : null}
      {data?.total === 0 ? <p className={styles.note}>No viewers recorded yet.</p> : null}
      <ul className={styles.people} aria-label="File viewers">
        {data?.viewers.map(viewer => <li key={`${viewer.email_source}:${viewer.email}:${viewer.first_viewed_at}`} className={styles.person}><span className={styles.who}>
          <span>{viewer.email}</span>
          <span className={styles.id}>{viewer.email_source === "account" ? "Account email" : "Entered email · unverified"}</span>
          <span className={styles.id}>First viewed {date(viewer.first_viewed_at)}<br />Last viewed {date(viewer.last_viewed_at)}</span>
        </span></li>)}
      </ul>
      {(offset > 0 || data?.next_offset != null) ? <div className={styles.publicHead}>
        <Button size="sm" variant="ghost" disabled={offset === 0 || isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous viewers</Button>
        <Button size="sm" variant="ghost" disabled={data?.next_offset == null || isFetching} onClick={() => setOffset(data?.next_offset ?? offset)}>Next viewers</Button>
      </div> : null}
    </div>
  </details>;
}
