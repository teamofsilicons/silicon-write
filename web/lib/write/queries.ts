"use client";

/**
 * React Query hooks for the service. Keys: ["library", view, folder], ["doc", id], ["sharing", kind, id],
 * ["threads", id, status], ["suggestions", id], ["versions", id], ["transfers"], ["folders"], ["docs"].
 */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, seg } from "@/lib/client/api";
import type { ActivityEvent, CompareBlock, Doc, Folder, Library, Sharing, Suggestion, Thread, Transfer, Version } from "./types";

export const keys = {
  library: (view: string, folder?: string | null) => ["library", view, folder ?? null] as QueryKey,
  doc: (id: string) => ["doc", id] as QueryKey,
  sharing: (kind: "docs" | "folders", id: string) => ["sharing", kind, id] as QueryKey,
  threads: (id: string, status: string) => ["threads", id, status] as QueryKey,
  suggestions: (id: string) => ["suggestions", id] as QueryKey,
  versions: (id: string) => ["versions", id] as QueryKey,
  transfers: ["transfers"] as QueryKey,
  folders: ["folders"] as QueryKey,
  docs: ["docs"] as QueryKey,
};

export function useLibrary(view: string, folder?: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.library(view, folder),
    queryFn: () => api.get<Library>("/v1/library", { query: { view, folder: folder ?? undefined } }),
    enabled,
  });
}

export function useAllFolders(enabled = true) {
  return useQuery({ queryKey: keys.folders, queryFn: () => api.get<{ folders: Folder[] }>("/v1/folders"), enabled });
}

export function useAllDocs(enabled = true) {
  return useQuery({ queryKey: keys.docs, queryFn: () => api.get<{ docs: Doc[] }>("/v1/docs"), enabled });
}

export function useTransfers() {
  return useQuery({ queryKey: keys.transfers, queryFn: () => api.get<{ incoming: Transfer[]; outgoing: Transfer[] }>("/v1/transfers") });
}

export function useSharing(kind: "docs" | "folders", id: string, enabled = true) {
  return useQuery({ queryKey: keys.sharing(kind, id), queryFn: () => api.get<Sharing>(`/v1/${kind}/${seg(id)}/sharing`), enabled });
}

export function useThreads(id: string, status: "open" | "resolved" | "all", enabled = true, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: keys.threads(id, status),
    queryFn: () => api.get<{ threads: Thread[] }>(`/v1/docs/${seg(id)}/threads`, { query: { status } }),
    enabled,
    refetchInterval,
  });
}

export function useSuggestions(id: string, enabled = true) {
  return useQuery({ queryKey: keys.suggestions(id), queryFn: () => api.get<{ suggestions: Suggestion[] }>(`/v1/docs/${seg(id)}/suggestions`), enabled });
}

export function useVersions(id: string, enabled = true) {
  return useQuery({ queryKey: keys.versions(id), queryFn: () => api.get<{ versions: Version[] }>(`/v1/docs/${seg(id)}/versions`), enabled });
}

export function useCompare(id: string, from: number | null, to: number | null) {
  return useQuery({
    queryKey: ["compare", id, from, to],
    queryFn: () => api.get<{ blocks: CompareBlock[]; from: number; to: number }>(`/v1/docs/${seg(id)}/compare`, { query: { from: from ?? 0, to: to ?? undefined } }),
    enabled: from !== null,
  });
}

export function useActivity(kind: "docs" | "folders", id: string, enabled = true) {
  return useQuery({ queryKey: ["activity", kind, id], queryFn: () => api.get<{ events: ActivityEvent[] }>(`/v1/${kind}/${seg(id)}/activity`), enabled });
}

/** Invalidates everything that lists docs and folders. */
export function useRefreshLibrary() {
  const client = useQueryClient();
  return () => {
    client.invalidateQueries({ queryKey: ["library"] });
    client.invalidateQueries({ queryKey: keys.folders });
    client.invalidateQueries({ queryKey: keys.docs });
    client.invalidateQueries({ queryKey: keys.transfers });
  };
}

export function useLibraryMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const refresh = useRefreshLibrary();
  return useMutation({ mutationFn: fn, onSuccess: () => refresh() });
}
