"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Mic, Square, RotateCcw, X, Loader2, Pause, Play, Trash2 } from "lucide-react";
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
  const busy = ["requesting", "recording", "paused", "uploading", "transcribing"].includes(draft.status);
  return {
    draft, busy, postingBlocked: busy || Boolean(draft.blob && !draft.recording), ready: Boolean(draft.recording) && !busy,
    start: () => { if (key) void voiceDrafts.start(key, docId, onTranscript); },
    pause: () => { if (key) voiceDrafts.pause(key); },
    discard: () => { if (key) voiceDrafts.discard(key); },
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
function Waveform({ stream, paused }: { stream?: MediaStream; paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!stream || !canvas.current) return;
    const element = canvas.current;
    let audio: AudioContext | undefined, frame = 0;
    try {
      audio = new AudioContext();
      const analyser = audio.createAnalyser(); analyser.fftSize = 256;
      audio.createMediaStreamSource(stream).connect(analyser);
      void audio.resume().catch(() => undefined);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        const ctx = element.getContext("2d"); if (!ctx) return;
        analyser.getByteTimeDomainData(values);
        const width = element.width = Math.round(element.clientWidth * devicePixelRatio), height = element.height = 64 * devicePixelRatio;
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = getComputedStyle(element).color; ctx.lineWidth = 2 * devicePixelRatio; ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i < values.length; i++) {
          const x = i / (values.length - 1) * width, y = height / 2 + (paused ? 0 : (values[i] - 128) / 128 * height * .48);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke(); frame = requestAnimationFrame(draw);
      };
      draw();
    } catch { /* A flat line remains if audio visualization is unavailable. */ }
    return () => { cancelAnimationFrame(frame); void audio?.close(); };
  }, [stream, paused]);
  return <canvas ref={canvas} className={styles.waveform} aria-label={paused ? "Recording paused" : "Live recording waveform"} role="img" />;
}
export function VoiceComment({ voice, disabled = false, children }: { voice: ReturnType<typeof useVoiceDraft>; disabled?: boolean; children?: ReactNode }) {
  const { draft } = voice;
  const preview = useRef<HTMLAudioElement>(null);
  const recording = draft.status === "recording" || draft.status === "paused";
  useEffect(() => {
    if (!draft.blob || !preview.current) return;
    const url = URL.createObjectURL(draft.blob); preview.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [draft.blob]);
  return <div className={styles.voice}>
    {draft.recording ? <VoicePlayer recording={draft.recording} /> : draft.blob ? <audio controls ref={preview} aria-label="Recording preview" /> : null}
    {recording ? <div className={styles.recorder} data-sq="input" aria-label="Voice recording">
      <div className={styles.recordingHeader}><span>{draft.status === "paused" ? "Paused" : "Recording"}</span><span role="timer">{duration(draft.elapsedMs ?? 0)}</span></div>
      <Waveform stream={draft.stream} paused={draft.status === "paused"} />
      <div className={styles.recordingControls}>
        <Button variant="ghost" size="sm" aria-label="Discard recording" title="Discard recording" onClick={voice.discard}><Trash2 size={17} /></Button>
        <Button key={draft.status} variant="secondary" size="sm" aria-label={draft.status === "paused" ? "Resume recording" : "Pause recording"} title={draft.status === "paused" ? "Resume recording" : "Pause recording"} onClick={voice.pause}>{draft.status === "paused" ? <Play size={16} /> : <Pause size={16} />}</Button>
        <Button variant="primary" size="sm" aria-label="Done recording" onClick={voice.stop}><Square size={14} fill="currentColor" /> Done</Button>
      </div>
    </div> : <div className={styles.field} data-mic={!draft.recording && !draft.blob || undefined}>
      {children}
      {!draft.recording && !draft.blob ? <Button className={styles.mic} variant="ghost" size="sm" disabled={disabled || voice.busy} aria-label="Record voice comment" title="Record voice comment" onClick={voice.start}><Mic size={18} /></Button> : null}
    </div>}
    {recording && draft.warned ? <p className={styles.warning} role="alert">5 minutes left. Recording stops automatically at 30 minutes.</p> : null}
    {!recording && voice.busy ? <span role="status" className={styles.status}><Loader2 size={14} className={styles.spin} /> {draft.status === "requesting" ? "Opening microphone…" : draft.status === "uploading" ? "Saving recording…" : "Transcribing…"}</span> : null}
    {!voice.busy && (draft.recording || draft.blob) ? <div className={styles.controls}>
      {draft.status === "error" ? <Button variant="ghost" size="sm" disabled={disabled} onClick={voice.retry}><RotateCcw size={14} /> {draft.recording ? "Retry transcription" : "Retry upload"}</Button> : null}
      <Button variant="ghost" size="sm" disabled={disabled} aria-label="Remove recording" onClick={voice.clear}><X size={14} /></Button>
    </div> : null}
    {draft.error ? <p role="alert" className={styles.error}>{draft.error}</p> : null}
    {draft.status === "ready" ? <p className={styles.caption}>{draft.recording?.transcript ? "You can edit the transcript before posting." : "No speech was detected. You can add text or post the recording."}</p> : null}
  </div>;
}
