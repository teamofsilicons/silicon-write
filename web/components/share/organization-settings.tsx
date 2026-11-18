"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import { api, seg } from "@/lib/client/api";
import { useSessionView } from "@/lib/client/session";
import { notify, notifyError } from "@/lib/notify";
import {
  useOrganizations,
  type Organization,
  type OrgSettings,
} from "@/lib/write/people";
import styles from "./share.module.css";

export function OrganizationSettings() {
  const orgs = useOrganizations();
  const [open, setOpen] = useState(false);
  const admins =
    orgs.data?.organizations.filter((o) => o.capabilities.admin) ?? [];
  if (!admins.length) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Organization settings
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Organization settings" className={styles.dialog}>
          {open &&
            admins.map((org) => (
              <OrganizationForm key={org.org_id} org={org} />
            ))}
        </DialogContent>
      </Dialog>
    </>
  );
}
function OrganizationForm({ org }: { org: Organization }) {
  const client = useQueryClient();
  const uuid = useSessionView().account?.uuid;
  const url = `/v1/organizations/${seg(org.org_id)}/settings`;
  const key = ["write-org-settings", uuid, org.org_id];
  const { data, error } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<OrgSettings>(url, { signal }),
  });
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = draft ?? data;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const next = await api.put<OrgSettings>(url, draft);
      client.setQueryData(key, next);
      setDraft(null);
      notify.success("Organization settings saved");
    } catch (e) {
      notifyError(e, "Couldn’t update organization settings");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.contactForm} onSubmit={save}>
      <h3>{org.name}</h3>
      {error && <p role="alert">{error.message}</p>}
      {settings && (
        <>
          <label>
            Default sharing role
            <select
              className={styles.inviteInput}
              value={settings.default_role}
              onChange={(e) =>
                setDraft({ ...settings, default_role: e.target.value })
              }
            >
              <option value="viewer">Viewer</option>
              <option value="commenter">Suggester</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.members_can_share}
              onChange={(e) =>
                setDraft({ ...settings, members_can_share: e.target.checked })
              }
            />{" "}
            Allow members to share with teams and the organization
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!draft}
          >
            Save settings
          </Button>
        </>
      )}
      <a
        href="https://organizations.teamofsilicons.com/"
        target="_blank"
        rel="noreferrer"
      >
        Manage members and teams in Organizations
      </a>
    </form>
  );
}
