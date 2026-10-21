"use client";

import { api, seg } from "@/lib/client/api";
import type { VoiceRecording } from "./types";

export type VoiceDraft = {
  status: "empty" | "requesting" | "recording" | "uploading" | "transcribing" | "ready" | "error";
  recording?: VoiceRecording;
  blob?: Blob;
  startedAt?: number;
  error?: string;
};
const EMPTY: VoiceDraft = { status: "empty" };
const drafts = new Map<string, VoiceDraft>();
const listeners = new Set<() => void>();
const jobs = new Map<string, Promise<void>>();
type Capture = { cancelled: boolean; recorder?: MediaRecorder; stream?: MediaStream; timer?: ReturnType<typeof setTimeout> };
const captures = new Map<string, Capture>();
const storageKey = (key: string) => `silicon-write:voice-draft:v1:${key}`;

async function blobStore(key: string, blob?: Blob | null): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-write-voice-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("recordings", blob === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("recordings");
      const operation = blob === undefined ? store.get(key) : blob === null ? store.delete(key) : store.put(blob, key);
      tx.oncomplete = () => { const result = operation.result; db.close(); resolve(result instanceof Blob ? result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
function read(key: string): VoiceDraft {
  if (!drafts.has(key)) {
    let value = EMPTY;
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey(key)) || "null");
      if (stored?.recording?.id && /^r_[A-Za-z0-9]+$/.test(stored.recording.id)) {
        value = { recording: stored.recording, status: stored.status === "ready" ? "ready" : "error", error: stored.status === "ready" ? undefined : "Your recording is saved. Retry transcription when you're ready." };
      } else if (stored) value = { status: "error", error: "Your recording draft is being restored." };
    } catch { /* A tab-local draft still works without browser storage. */ }
    drafts.set(key, value);
  }
  return drafts.get(key)!;
}
function write(key: string, value: VoiceDraft) {
  drafts.set(key, value);
  try {
    if (value.status === "empty") sessionStorage.removeItem(storageKey(key));
    else sessionStorage.setItem(storageKey(key), JSON.stringify({ status: value.status, recording: value.recording }));
  } catch { /* Keep the in-memory draft. */ }
  listeners.forEach(listener => listener());
}
function stop(key: string) {
  const capture = captures.get(key);
  if (!capture) return;
  capture.cancelled = true;
  if (capture.timer) clearTimeout(capture.timer);
  if (capture.recorder?.state === "recording") capture.recorder.stop();
  capture.stream?.getTracks().forEach(track => track.stop());
}
async function process(key: string, docId: string, onTranscript: (text: string) => void) {
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    let draft = read(key);
    try {
      if (!draft.recording) {
        const blob = draft.blob ?? await blobStore(key);
        if (!blob) throw new Error("The recording couldn't be restored. Please record it again.");
        if (blob.size > 3 * 1024 * 1024) throw new Error("This recording is too large. Please record a shorter comment.");
        write(key, { ...draft, blob, status: "uploading", error: undefined });
        const data = new FormData(); data.append("audio", blob, "voice-comment");
        const recording = await api.post<VoiceRecording>(`/v1/docs/${seg(docId)}/recordings`, undefined, { raw: data });
        draft = { recording, status: "transcribing" };
        write(key, draft);
        await blobStore(key, null).catch(() => undefined);
      }
      write(key, { ...draft, status: "transcribing", error: undefined });
      const result = await api.post<{ transcript: string }>(`/v1/recordings/${seg(draft.recording!.id)}/transcribe`, {});
      onTranscript(result.transcript);
      write(key, { recording: { ...draft.recording!, transcript: result.transcript }, status: "ready" });
    } catch (error) {
      write(key, { ...read(key), status: "error", error: error instanceof Error ? error.message : "The recording couldn't be processed. Try again." });
    }
  })();
  jobs.set(key, job);
  try { await job; } finally { jobs.delete(key); }
}
async function start(key: string, docId: string, onTranscript: (text: string) => void) {
  if (captures.has(key) || jobs.has(key)) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    write(key, { status: "error", error: "This browser can't record audio. Try a recent Chrome, Safari, Firefox or Edge browser." }); return;
  }
  const capture: Capture = { cancelled: false };
  captures.set(key, capture);
  write(key, { status: "requesting" });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    capture.stream = stream;
    if (capture.cancelled) { stream.getTracks().forEach(track => track.stop()); captures.delete(key); write(key, EMPTY); return; }
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    capture.recorder = recorder;
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (capture.timer) clearTimeout(capture.timer);
      captures.delete(key);
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      if (!blob.size) { write(key, { status: "error", error: "No audio was captured. Check your microphone and try again." }); return; }
      write(key, { blob, status: "uploading" });
      void blobStore(key, blob).catch(() => undefined).then(() => process(key, docId, onTranscript));
    };
    recorder.onerror = () => stop(key);
    recorder.start(1000);
    write(key, { status: "recording", startedAt: Date.now() });
    capture.timer = setTimeout(() => stop(key), 179000);
  } catch (error) {
    capture.stream?.getTracks().forEach(track => track.stop()); captures.delete(key);
    write(key, { status: "error", error: error instanceof DOMException && error.name === "NotAllowedError" ? "Microphone access was denied. Allow the microphone in your browser, then try again." : "The microphone couldn't be opened. Check that it's connected and try again." });
  }
}
export const voiceDrafts = {
  read, empty: EMPTY, start, stop, process,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async restore(key: string) {
    const value = read(key);
    if (value.status !== "error" || value.recording || value.blob) return;
    const blob = await blobStore(key).catch(() => undefined);
    if (blob && read(key) === value) write(key, { blob, status: "error", error: "Your recording is saved. Retry to upload and transcribe it." });
  },
  clear(key: string, expected?: VoiceDraft) {
    if (expected && read(key) !== expected || captures.has(key) || jobs.has(key)) return;
    write(key, EMPTY); void blobStore(key, null).catch(() => undefined);
  },
};
