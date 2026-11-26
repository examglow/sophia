import { createFileRoute } from "@tanstack/react-router";
import { Keyboard, Mic, MicOff, PhoneOff, Send } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ReactiveWave, type WaveMode } from "@/components/ReactiveWave";
import { VisualResultsDeck } from "@/components/VisualResultsDeck";
import { useLiveVoice, type LiveEvent } from "@/hooks/use-live-voice";
import type { VisualResultsPayload } from "@/lib/visual-results";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sophia — Shikari's Coding Companion" },
      { name: "description", content: "A live voice AI coding companion with web search and visual results." },
      { property: "og:title", content: "Sophia — Shikari's Coding Companion" },
      { property: "og:description", content: "Talk to Sophia: live voice, web search and visual result cards." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [activity, setActivity] = useState<"thinking" | "searching" | "checkin" | null>(null);
  const [visuals, setVisuals] = useState<VisualResultsPayload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [speaking, setSpeaking] = useState(false);

  const onEvent = useCallback((event: LiveEvent) => {
    switch (event.type) {
      case "app.delegation.pending":
        setActivity("thinking");
        break;
      case "app.delegation.searching":
        setActivity("searching");
        break;
      case "app.checkin.triggered":
        setActivity("checkin");
        break;
      case "app.delegation.completed":
        setActivity(null);
        break;
      case "app.delegation.error":
        setActivity(null);
        setNotice(event.error?.message ?? "Lookup failed.");
        break;
      case "app.visual.results":
        if (event.payload) setVisuals(event.payload);
        break;
      case "app.closed":
        setActivity(null);
        break;
    }
  }, []);

  const voice = useLiveVoice({ onEvent });
  const live = voice.status === "connecting" || voice.status === "connected";

  useEffect(() => {
    if (voice.status !== "connected") return setSpeaking(false);
    const id = setInterval(() => setSpeaking(voice.getAudioLevels().output > 0.06), 150);
    return () => clearInterval(id);
  }, [voice.status, voice.getAudioLevels]);

  const mode: WaveMode =
    voice.status === "connecting"
      ? "connecting"
      : voice.status === "stopping"
        ? "stopping"
        : voice.status !== "connected"
          ? "idle"
          : activity ?? (speaking ? "speaking" : voice.muted ? "muted" : "listening");

  const wake = () => {
    setNotice(null);
    voice.start(textMode ? { startMuted: true } : undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setNotice(null);
    if (voice.status === "connected") {
      if (!voice.sendText(text)) setNotice("Message could not be sent.");
    } else if (!live) {
      voice.start({ initialText: text, startMuted: true });
    }
    setDraft("");
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-10 font-sans text-foreground">
      <header className="absolute left-6 top-6 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-primary" />
        <h1 className="font-display text-sm font-medium tracking-[0.3em]">SOPHIA</h1>
      </header>

      <ReactiveWave
        mode={mode}
        canWake={!live}
        compact={Boolean(visuals)}
        onWake={wake}
        getAudioLevels={voice.getAudioLevels}
      />

      {(voice.error || notice) && (
        <p role="alert" className="max-w-md text-center text-sm text-destructive">
          {voice.error ?? notice}
        </p>
      )}
      {voice.playbackBlocked && (
        <button onClick={voice.resumePlayback} className="rounded-full border border-border bg-card px-4 py-2 text-sm">
          Tap to enable sound
        </button>
      )}

      {visuals && <VisualResultsDeck payload={visuals} onDismiss={() => setVisuals(null)} />}

      {textMode && (
        <form onSubmit={submit} className="flex w-full max-w-xl items-center gap-2 rounded-full border border-border bg-card/70 p-1.5 pl-5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type to Sophia…"
            aria-label="Message Sophia"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button type="submit" aria-label="Send" className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Send className="h-4 w-4" />
          </button>
        </form>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            const next = !textMode;
            setTextMode(next);
            if (voice.status === "connected") voice.setMuted(next);
          }}
          aria-label={textMode ? "Switch to voice mode" : "Switch to text mode"}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
        >
          {textMode ? <Mic className="h-4 w-4" /> : <Keyboard className="h-4 w-4" />}
        </button>
        {voice.status === "connected" && !textMode && (
          <button
            onClick={() => voice.setMuted(!voice.muted)}
            aria-label={voice.muted ? "Unmute" : "Mute"}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
          >
            {voice.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
        )}
        {live && (
          <button
            onClick={voice.stop}
            aria-label="End session"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        )}
      </div>

      <audio ref={voice.audioRef} autoPlay className="hidden" />
    </main>
  );
}
