"use client";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/silicon-ui/button/button";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { api } from "@/lib/client/api";
import { displayName } from "@/lib/write/types";
import { photo, usePeople } from "@/lib/write/people";
import { notify, notifyError } from "@/lib/notify";
import { Recipient } from "./recipient";
import styles from "./share.module.css";

export function ContactsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Contacts
      </Button>
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Silicon Contacts" className={styles.dialog}>
            <Contacts />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
function Contacts() {
  const client = useQueryClient();
  const directory = usePeople();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [trust, setTrust] = useState("1");
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const refresh = async () => {
    client.removeQueries({ queryKey: ["write-person"] });
    await client.invalidateQueries({ queryKey: ["write-people"] });
  };
  async function connect(connected: boolean) {
    setBusy(true);
    try {
      await api.put("/v1/contacts/connection", { connected });
      await refresh();
    } catch (e) {
      notifyError(e, "Couldn’t change the Contacts connection");
    } finally {
      setBusy(false);
    }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/v1/contacts", { id, name, trust: Number(trust) });
      setId("");
      setName("");
      setTrust("1");
      await refresh();
      notify.success("Contact saved");
    } catch (error) {
      notifyError(error, "Couldn’t save this contact");
    } finally {
      setBusy(false);
    }
  }
  if (directory.isPending) return <p role="status">Loading contacts…</p>;
  if (directory.error)
    return (
      <p role="alert">
        {directory.error.message}{" "}
        <button onClick={() => void directory.refetch()}>Retry</button>
      </p>
    );
  if (directory.data.status === "disconnected")
    return (
      <div className={styles.body}>
        <p>
          Let Write read your saved names, photos and trust levels, and save
          contacts to your Silicon Contacts address book.
        </p>
        <Button
          variant="primary"
          loading={busy}
          onClick={() => void connect(true)}
        >
          Connect Silicon Contacts
        </Button>
      </div>
    );
  const items = directory.data.items;
  return (
    <div className={styles.body}>
      {directory.data.status === "unavailable" && (
        <p role="alert">
          Your address book couldn’t be loaded.{" "}
          <button onClick={() => void directory.refetch()}>Retry</button>
        </p>
      )}
      <form className={styles.contactForm} onSubmit={add}>
        <label htmlFor={fieldId}>Carbon or Silicon</label>
        <Recipient
          id={fieldId}
          value={id}
          onChange={setId}
          people={items}
          label="Contact account"
          placeholder="c:id or si:id"
        />
        <label>
          Saved name
          <input
            className={styles.inviteInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          Trust (1–255)
          <input
            className={styles.inviteInput}
            type="number"
            value={trust}
            min={1}
            max={255}
            required
            onChange={(e) => setTrust(e.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={
            !name.trim() || !id.trim() || directory.data.status !== "connected"
          }
        >
          Add contact
        </Button>
      </form>
      <ul className={styles.people} aria-label="Saved contacts">
        {items
          .filter((p) => p.trust)
          .map((p) => (
            <li className={styles.person} key={p.uuid}>
              <Avatar name={displayName(p)} src={photo(p)} size="sm" />
              <span className={styles.who}>
                {displayName(p)}
                <small>{p.id}</small>
              </span>
              <small>Trust {p.trust}</small>
            </li>
          ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={() => void connect(false)}
      >
        Disconnect Contacts
      </Button>
    </div>
  );
}
