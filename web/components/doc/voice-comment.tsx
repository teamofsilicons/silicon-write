"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square, RotateCcw, X, Loader2 } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { voiceDrafts } from "@/lib/write/voice-drafts";
import type { VoiceRecording } from "@/lib/write/types";
import styles from "./voice-comment.module.css";

export function useVoiceDraft(key: string | null, docId: string, onTranscript: (text: string) => void) {
  const snapshot = useCallback(() => key ? voiceDrafts.read(key) : voiceDrafts.empty, [key]);
  const draft = useSyncExternalStore(voiceDrafts.subscribe, snapshot, () => voiceDrafts.empty);
  useEffect(() => {
    if (key) void voiceDrafts.restore(key);
    return () => { if (key) voiceDrafts.stop(key); };
  }, [key]);
  const busy = ["requesting", "recording", "uploading", "transcribing"].includes(draft.status);
  return {
    draft, busy, postingBlocked: busy || Boolean(draft.blob && !draft.recording), ready: Boolean(draft.recording) && !busy,
    start: () => { if (key) void voiceDrafts.start(key, docId, onTranscript); },
    stop: () => { if (key) voiceDrafts.stop(key); },
    retry: () => { if (key) void voiceDrafts.process(key, docId, onTranscript); },
    clear: () => { if (key) voiceDrafts.clear(key, draft); },
  };
}
export function VoicePlayer({ recording }: { recording: VoiceRecording }) {
  return <div className={styles.player}>
    <audio controls preload="metadata" src={`/api/v1/recordings/${encodeURIComponent(recording.id)}`} aria-label="Voice comment recording" />
    <span className={styles.caption}>Voice comment · {duration(recording.duration_ms)}</span>
  </div>;
}
function duration(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
export function VoiceComment({ voice, disabled = false }: { voice: ReturnType<typeof useVoiceDraft>; disabled?: boolean }) {
  const { draft } = voice;
  const [now, setNow] = useState(0);
  const preview = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (draft.status !== "recording") return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [draft.status]);
  useEffect(() => {
    if (!draft.blob || !preview.current) return;
    const url = URL.createObjectURL(draft.blob); preview.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [draft.blob]);
  return <div className={styles.voice}>
    {draft.recording ? <VoicePlayer recording={draft.recording} /> : draft.blob ? <audio controls ref={preview} aria-label="Recording preview" /> : null}
    <div className={styles.controls}>
      {draft.status === "recording" ? <>
        <Button variant="secondary" size="sm" onClick={voice.stop}><Square size={14} fill="currentColor" /> Stop recording</Button>
        <span role="timer">{duration(Math.max(0, now - (draft.startedAt || now)))} / 3:00</span>
      </> : voice.busy ? <span role="status" className={styles.status}><Loader2 size={14} className={styles.spin} /> {draft.status === "requesting" ? "Opening microphone…" : draft.status === "uploading" ? "Saving recording…" : "Transcribing…"}</span> : <>
        {!draft.recording && !draft.blob ? <Button variant="ghost" size="sm" disabled={disabled} onClick={voice.start}><Mic size={15} /> Record voice comment</Button> : null}
        {draft.status === "error" && (draft.recording || draft.blob) ? <Button variant="ghost" size="sm" disabled={disabled} onClick={voice.retry}><RotateCcw size={14} /> {draft.recording ? "Retry transcription" : "Retry upload"}</Button> : null}
        {draft.recording || draft.blob ? <Button variant="ghost" size="sm" disabled={disabled} aria-label="Remove recording" onClick={voice.clear}><X size={14} /></Button> : null}
      </>}
    </div>
    {draft.error ? <p role="alert" className={styles.error}>{draft.error}</p> : null}
    {draft.status === "ready" ? <p className={styles.caption}>{draft.recording?.transcript ? "Transcript added below. You can edit it before posting." : "No speech was detected. You can add text or post the recording."}</p> : draft.status === "empty" ? <p className={styles.caption}>Up to 3 minutes. Audio is transcribed by Deepgram when you stop.</p> : null}
  </div>;
}
