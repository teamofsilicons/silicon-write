"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useSessionView } from "@/lib/client/session";
import type { Account } from "./types";

export type Person = Account & {
  trust?: number;
  photo_url?: string | null;
  email?: string;
};
export function selectedPerson(
  value: string,
  people: Person[],
): Person | undefined {
  const term = value.trim().toLowerCase();
  if (!term) return;
  const byId = people.find((person) => person.id.toLowerCase() === term);
  if (byId) return byId;
  const byEmail = people.filter(
    (person) => person.email?.toLowerCase() === term,
  );
  return byEmail.length === 1 ? byEmail[0] : undefined;
}

export type Group = {
  type: "team" | "organization";
  id: string;
  name: string;
  org_id: string;
};
export type Organization = {
  org_id: string;
  name: string;
  capabilities: { admin: boolean };
};
export type OrgSettings = { members_can_share: boolean; default_role: string };
type PeoplePage = {
  items: Person[];
  total: number;
  contacts_status: "connected" | "disconnected" | "unavailable";
};

export function usePeople(enabled = true) {
  const uuid = useSessionView().account?.uuid;
  return useQuery({
    queryKey: ["write-people", uuid],
    enabled: Boolean(enabled && uuid),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const items: Person[] = [];
      let page: PeoplePage;
      do {
        page = await api.get<PeoplePage>(
          `/v1/people?limit=200&offset=${items.length}`,
          { signal },
        );
        items.push(...page.items);
      } while (page.items.length && items.length < page.total);
      return { items, status: page.contacts_status };
    },
  });
}

export function useSavedPeople(enabled = true) {
  const { data } = usePeople(enabled);
  return useMemo(() => {
    const people = new Map<string, Person>();
    for (const person of data?.items ?? []) {
      if (!person.trust) continue;
      people.set(person.uuid, person);
      people.set(person.id, person);
    }
    return people;
  }, [data]);
}

export function useOrganizations(enabled = true) {
  const uuid = useSessionView().account?.uuid;
  return useQuery({
    queryKey: ["write-organizations", uuid],
    enabled: Boolean(enabled && uuid),
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api.get<{ organizations: Organization[]; share_targets: Group[] }>(
        "/v1/organizations",
        { signal },
      ),
  });
}
export const photo = (p: Person) =>
  p.photo_url ? `/api${p.photo_url}` : p.pfp_url || undefined;
export const groupKey = (g: Group) => `${g.type}:${g.id}`;
export function mergePeople(
  saved: Person[],
  others: (Account | null | undefined)[],
) {
  const people = new Map<string, Person>();
  for (const a of others) if (a?.id) people.set(a.uuid, a);
  for (const p of saved)
    people.set(p.uuid, {
      ...p,
      pfp_url: p.pfp_url || people.get(p.uuid)?.pfp_url || "",
    });
  return [...people.values()].sort(
    (a, b) =>
      (b.trust ?? 0) - (a.trust ?? 0) ||
      (a.display_name || a.id).localeCompare(b.display_name || b.id),
  );
}
