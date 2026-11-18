"use client";
import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { api } from "@/lib/client/api";
import { useSessionView } from "@/lib/client/session";
import { displayName } from "@/lib/write/types";
import { fuzzy } from "@/lib/write/fuzzy";
import {
  selectedPerson,
  groupKey,
  photo,
  type Group,
  type Person,
} from "@/lib/write/people";
import styles from "./share.module.css";

type Props = {
  id?: string;
  label: string;
  value: string;
  placeholder: string;
  autoFocus?: boolean;
  people: Person[];
  groups?: Group[];
  onChange: (value: string) => void;
  onGroup?: (g: Group) => void;
};
export function Recipient({
  id,
  label,
  value,
  placeholder,
  autoFocus,
  people,
  groups = [],
  onChange,
  onGroup,
}: Props) {
  const list = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [term, setTerm] = useState("");
  const account = useSessionView().account;
  const typed = value.trim().toLowerCase();
  useEffect(() => {
    const timer = setTimeout(() => setTerm(typed), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const known = selectedPerson(typed, people);
  const exact = useQuery({
    queryKey: ["write-person", account?.uuid, term],
    enabled:
      !!account &&
      term === typed &&
      !known &&
      /^(c|si):[a-z0-9_-]+(?:\.[a-z0-9_-]+)?$/.test(term),
    queryFn: ({ signal }) =>
      api.get<{ person: Person }>(
        `/v1/people/lookup?q=${encodeURIComponent(term)}`,
        { signal },
      ),
    retry: false,
    staleTime: 30_000,
  });
  const person = known || (typed === term ? exact.data?.person : undefined);
  const group = groups.find((g) => groupKey(g) === typed);
  const options = [
    ...people
      .filter(
        (p) =>
          p.uuid !== account?.uuid &&
          fuzzy(typed, p.id, p.display_name, p.email),
      )
      .map((p) => ({
        key: p.id,
        name: displayName(p),
        src: photo(p),
        group: undefined as Group | undefined,
      })),
    ...groups
      .filter((g) => fuzzy(typed, g.name, groupKey(g)))
      .map((g) => ({
        key: groupKey(g),
        name: g.name,
        src: undefined,
        group: g,
      })),
  ].slice(0, 10);
  const open = focused && !person && !group && options.length > 0;
  const at = Math.min(active, options.length - 1);
  const pick = (option: (typeof options)[number]) => {
    onChange(option.key);
    if (option.group) onGroup?.(option.group);
    setFocused(false);
  };
  return (
    <div className={styles.recipient}>
      <input
        id={id}
        role="combobox"
        aria-label={label}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={list}
        aria-activedescendant={open ? `${list}-${at}` : undefined}
        className={styles.inviteInput}
        value={value}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setFocused(true);
        }}
        onKeyDown={(e) => {
          if (open && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            setActive(
              (at + (e.key === "ArrowUp" ? -1 : 1) + options.length) %
                options.length,
            );
          }
          if (open && e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            pick(options[at]!);
          }
          if (open && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setFocused(false);
          }
        }}
      />
      {open && (
        <ul
          className={styles.options}
          role="listbox"
          id={list}
          aria-label={`${label} suggestions`}
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${list}-${i}`}
              role="option"
              aria-selected={i === at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onMouseMove={() => setActive(i)}
            >
              {o.group ? (
                <Users size={19} />
              ) : (
                <Avatar name={o.name} src={o.src} size="sm" />
              )}
              <span>
                {o.name}
                <small>{o.key}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {person || group ? (
        <div className={styles.previewPerson} aria-live="polite">
          {person ? (
            <Avatar name={displayName(person)} src={photo(person)} size="sm" />
          ) : (
            <Users size={17} />
          )}
          <span>{person ? displayName(person) : group?.name}</span>
        </div>
      ) : null}
    </div>
  );
}
