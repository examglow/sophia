import { useCallback, useEffect, useRef, useState } from "react";

import type { VisualResultsPayload } from "@/lib/visual-results";

export type LiveEvent = {
  type: string;
  reason?: string;
  error?: { message?: string };
  usage?: { seconds?: number };
  finalized?: boolean;
  payload?: VisualResultsPayload;
  text?: string;
  [key: string]: unknown;
};

export type AudioLevels = {
  input: number;
  output: number;
  bands: number[];
};

export type StartCallOptions = {
  initialText?: string;
  startMuted?: boolean;
};

type LiveState = {
  status: "idle" | "connecting" | "connected" | "stopping" | "closed";
  error: string | null;
  hasConnected: boolean;
  finalized: boolean | null;
  muted: boolean;
  playbackBlocked: boolean;
};

const initialState: LiveState = {
  status: "idle",
  error: null,
  hasConnected: false,
  finalized: null,
  muted: false,
  playbackBlocked: false,
};

const EMPTY_BANDS = [0, 0, 0, 0, 0, 0, 0, 0];

export function useLiveVoice(
  options: {
    url?: string;
    onEvent?: (event: LiveEvent) => void | Promise<void>;
  } = {},
) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controller = useRef<ReturnType<typeof createLiveVoice> | null>(null);
  const mounted = useRef(false);
  const latest = useRef(options);
  const [call, setCall] = useState(initialState);

  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const voice = controller.current;
      controller.current = null;
      voice?.stop();
    };
  }, []);

  const start = useCallback((startOptions?: StartCallOptions) => {
    if (!mounted.current || controller.current) return;
    let endpoint: URL;
    try {
      endpoint = new URL(latest.current.url ?? "/api/live", window.location.href);
      if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
      if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
    } catch {
      setCall((previous) => ({ ...previous, error: "Invalid voice connection URL." }));
      return;
    }
    const startMuted = Boolean(startOptions?.startMuted);
    const initialText = startOptions?.initialText?.trim() || undefined;

    const voice = createLiveVoice({
      url: endpoint.href,
      startMuted,
      ...(initialText ? { initialText } : {}),
      onEvent(event) {
        if (!mounted.current || controller.current !== voice) return;
        if (event.type === "app.connected") {
          setCall((previous) => ({ ...previous, status: "connected", hasConnected: true }));
        } else if (event.type === "app.stopping") {
          setCall((previous) => ({ ...previous, status: "stopping", playbackBlocked: false }));
        } else if (event.type === "app.closed") {
          controller.current = null;
          setCall((previous) => ({
            ...previous,
            status: "closed",
            muted: false,
            playbackBlocked: false,
            finalized: event.finalized === true,
          }));
        } else if (event.type === "app.playback.blocked" || event.type === "app.playback.resumed") {
          setCall((previous) => ({
            ...previous,
            playbackBlocked: event.type === "app.playback.blocked",
          }));
        } else if (["app.error", "gateway.error", "error"].includes(event.type)) {
          setCall((previous) => ({
            ...previous,
            error: event.error?.message ?? "Voice request failed.",
          }));
        }
        try {
          void Promise.resolve(latest.current.onEvent?.(event)).catch(() => {
            console.error("Live UI event handler failed");
          });
        } catch {
          console.error("Live UI event handler failed");
        }
      },
    });

    controller.current = voice;
    setCall({ ...initialState, status: "connecting", muted: startMuted });
    void voice.start();
  }, []);

  const stop = useCallback(() => {
    controller.current?.stop();
  }, []);
  const setMuted = useCallback((muted: boolean) => {
    if (controller.current?.setMuted(muted)) setCall((previous) => ({ ...previous, muted }));
  }, []);
  const sendText = useCallback((text: string): boolean => {
    return controller.current?.sendText(text) ?? false;
  }, []);
  const sendLocation = useCallback(
    (location: { latitude: number; longitude: number; accuracy?: number; city?: string; label?: string }): boolean => {
      return controller.current?.sendLocation(location) ?? false;
    },
    [],
  );
  const resumePlayback = useCallback(() => {
    void controller.current?.resumePlayback();
  }, []);
  const getAudioLevels = useCallback((): AudioLevels => {
    return controller.current?.getAudioLevels() ?? { input: 0, output: 0, bands: EMPTY_BANDS };
  }, []);

  return { ...call, audioRef, start, stop, setMuted, sendText, sendLocation, resumePlayback, getAudioLevels };
}

type LiveOptions = {
  url: string;
  startMuted: boolean;
  initialText?: string;
  onEvent: (event: LiveEvent) => void;
};

function sampleRms(analyser: AnalyserNode, buffer: Uint8Array): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = ((buffer[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 3.2);
}

function sampleBands(analyser: AnalyserNode, buffer: Uint8Array): number[] {
  analyser.getByteFrequencyData(buffer);
  const out: number[] = [];
  const count = 8;
  const span = Math.max(1, Math.floor((buffer.length * 0.65) / count));
  for (let b = 0; b < count; b++) {
    let acc = 0;
    const offset = b * span;
    for (let i = 0; i < span; i++) acc += buffer[offset + i] ?? 0;
    out.push(Math.min(1, (acc / (span * 255)) * 1.45));
  }
  return out;
}

function base64ToUint8(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Downsample to 16kHz PCM16 for Google Gemini
function downsampleTo16k(input: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 16000) {
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i] ?? 0));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(input.length / ratio);
  const result = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const index = Math.min(Math.round(i * ratio), input.length - 1);
    const s = Math.max(-1, Math.min(1, input[index] ?? 0));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return result;
}

function createLiveVoice(options: LiveOptions) {
  let state: "idle" | "starting" | "active" | "stopping" | "closed" = "idle";
  let socket: WebSocket | undefined;
  let microphone: MediaStream | undefined;
  let muted = options.startMuted;

  // Single shared AudioContext for rock-solid sync and zero Web Audio mismatch
  let audioCtx: AudioContext | undefined;
  let inputAnalyser: AnalyserNode | undefined;
  let outputAnalyser: AnalyserNode | undefined;
  let inputTimeBuf: Uint8Array | undefined;
  let outputTimeBuf: Uint8Array | undefined;
  let freqBuf: Uint8Array | undefined;

  let scheduledPlaybackTime = 0;
  let activeSources: AudioBufferSourceNode[] = [];

  // Speech utterance buffer & Voice Activity Detection (VAD)
  const speechChunks: Int16Array[] = [];
  let isSpeaking = false;
  let speechSilenceTimer: ReturnType<typeof setTimeout> | undefined;

  function send(event: object) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  function getAudioLevels(): AudioLevels {
    if (state !== "active" && state !== "starting") {
      return { input: 0, output: 0, bands: EMPTY_BANDS };
    }
    const input =
      !muted && inputAnalyser && inputTimeBuf ? sampleRms(inputAnalyser, inputTimeBuf) : 0;
    const output = outputAnalyser && outputTimeBuf ? sampleRms(outputAnalyser, outputTimeBuf) : 0;
    const activeAnalyser = output >= input && outputAnalyser ? outputAnalyser : inputAnalyser;
    const bands = activeAnalyser && freqBuf ? sampleBands(activeAnalyser, freqBuf) : EMPTY_BANDS;
    return { input, output, bands };
  }

  function stopAllPlayback() {
    for (const source of activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // already stopped
      }
    }
    activeSources = [];
    if (audioCtx) {
      scheduledPlaybackTime = audioCtx.currentTime;
    }
  }

  function playPcmChunk(base64Pcm: string) {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === "suspended") {
        void audioCtx.resume().catch(() => {});
      }

      const pcmBytes = base64ToUint8(base64Pcm);
      const int16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }

      // Gemini native audio output rate is 24000Hz
      const audioBuffer = audioCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = 1.0;

      if (outputAnalyser) {
        source.connect(outputAnalyser);
        outputAnalyser.connect(audioCtx.destination);
      } else {
        source.connect(audioCtx.destination);
      }

      const currentTime = audioCtx.currentTime;
      // Pre-buffering jitter buffer: 180ms safety window prevents speaker buffer underruns, clicks, cracks, and hooks
      if (scheduledPlaybackTime < currentTime) {
        scheduledPlaybackTime = currentTime + 0.18;
      }

      source.start(scheduledPlaybackTime);
      scheduledPlaybackTime += audioBuffer.duration;

      activeSources.push(source);
      source.onended = () => {
        activeSources = activeSources.filter((s) => s !== source);
      };
    } catch (err) {
      console.error("[AudioPlayback] Error playing PCM chunk:", err);
    }
  }

  function flushSpeechUtterance() {
    if (speechChunks.length === 0) return;
    let totalSamples = 0;
    for (const chunk of speechChunks) {
      totalSamples += chunk.length;
    }
    // Only send if there was meaningful speech (> 0.25 seconds = 4000 samples at 16kHz)
    if (totalSamples > 4000) {
      const merged = new Int16Array(totalSamples);
      let offset = 0;
      for (const chunk of speechChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      send({
        type: "user_audio_utterance",
        pcm: arrayBufferToBase64(merged.buffer),
      });
    }
    speechChunks.length = 0;
    isSpeaking = false;
  }

  function stopAudio() {
    clearTimeout(speechSilenceTimer);
    stopAllPlayback();
    microphone?.getTracks().forEach((track) => track.stop());

    if (audioCtx && audioCtx.state !== "closed") {
      void audioCtx.close().catch(() => {});
    }
    audioCtx = undefined;
    inputAnalyser = undefined;
    outputAnalyser = undefined;
  }

  function release() {
    if (state === "closed") return;
    state = "closed";
    stopAudio();
    socket?.close();
    options.onEvent({ type: "app.closed" });
  }

  function stop() {
    if (state === "stopping" || state === "closed") return;
    state = "stopping";
    try {
      send({ type: "session.close" });
    } catch {
      return release();
    }
    options.onEvent({ type: "app.stopping" });
    release();
  }

  function setMuted(value: boolean) {
    muted = value;
    microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (muted) {
      clearTimeout(speechSilenceTimer);
      speechChunks.length = 0;
      isSpeaking = false;
    }
    return true;
  }

  function sendText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || socket?.readyState !== WebSocket.OPEN) return false;
    try {
      send({ type: "app.text_input", text: trimmed });
      return true;
    } catch {
      return false;
    }
  }

  function sendLocation(location: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    city?: string;
    label?: string;
  }): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      send({ type: "app.location", ...location });
      return true;
    } catch {
      return false;
    }
  }

  async function resumePlayback() {
    if (audioCtx?.state === "suspended") {
      await audioCtx.resume();
      options.onEvent({ type: "app.playback.resumed" });
    }
  }

  function fail(message: string) {
    if (state === "stopping" || state === "closed") return;
    options.onEvent({ type: "app.error", error: { message } });
    stop();
  }

  async function start() {
    if (state !== "idle") return;
    state = "starting";

    try {
      // 1. Setup single AudioContext for input & output
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextClass();
      audioCtx = ctx;

      // Immediately resume on user gesture click
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }

      outputAnalyser = ctx.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputAnalyser.smoothingTimeConstant = 0.78;
      outputTimeBuf = new Uint8Array(outputAnalyser.fftSize);
      freqBuf = new Uint8Array(outputAnalyser.frequencyBinCount);

      // 2. Request microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      microphone = stream;

      // 3. Connect microphone to input analyser
      const micSource = ctx.createMediaStreamSource(stream);
      inputAnalyser = ctx.createAnalyser();
      inputAnalyser.fftSize = 256;
      inputAnalyser.smoothingTimeConstant = 0.78;
      inputTimeBuf = new Uint8Array(inputAnalyser.fftSize);
      micSource.connect(inputAnalyser);

      // 4. Capture audio, downsample to 16kHz PCM, and buffer speech utterances
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (e) => {
        if (muted || socket?.readyState !== WebSocket.OPEN) return;

        const input = e.inputBuffer.getChannelData(0);

        // Calculate RMS audio energy
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          const v = input[i] ?? 0;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / input.length);

        // Barge-in: if user speaks while assistant is speaking, stop playback immediately
        if (rms > 0.04 && activeSources.length > 0) {
          stopAllPlayback();
        }

        const pcm16 = downsampleTo16k(input, ctx.sampleRate);

        // Voice Activity Detection (VAD)
        if (rms > 0.018) {
          // User is actively speaking
          isSpeaking = true;
          speechChunks.push(pcm16);
          clearTimeout(speechSilenceTimer);
          // Set silence timeout: 650ms of quiet triggers utterance flush
          speechSilenceTimer = setTimeout(flushSpeechUtterance, 650);
        } else if (isSpeaking) {
          // Trailing silence frame while user paused
          speechChunks.push(pcm16);
        }
      };

      // Connect through 0-gain node so user does NOT hear their own microphone in speakers
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      micSource.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(ctx.destination);

      // 5. Connect WebSocket to server
      socket = new WebSocket(options.url);

      socket.onopen = () => {
        send({
          type: "app.start",
          ...(options.initialText ? { initialText: options.initialText } : {}),
        });
      };

      socket.onmessage = ({ data }) => {
        try {
          const event: LiveEvent = JSON.parse(data);

          if (event.type === "app.connected") {
            state = "active";
            options.onEvent({ type: "app.connected" });
          } else if (event.type === "output_audio" && typeof event.pcm === "string") {
            playPcmChunk(event.pcm);
          } else if (event.type === "app.playback.interrupted") {
            stopAllPlayback();
          } else if (event.type === "app.visual.results") {
            options.onEvent(event);
          } else if (event.type === "app.delegation.searching" || event.type === "app.delegation.completed") {
            options.onEvent(event);
          } else if (event.type === "app.error") {
            options.onEvent(event);
          } else if (event.type === "app.closed") {
            release();
          }
        } catch (err) {
          console.error("[LiveClient] Error parsing message:", err);
        }
      };

      socket.onerror = () => fail("Voice connection failed. Tap to retry.");
      socket.onclose = () => {
        if (state !== "stopping" && state !== "closed") {
          options.onEvent({
            type: "app.error",
            error: { message: "Voice connection closed" },
          });
        }
        release();
      };
    } catch (err) {
      fail(err instanceof Error ? err.message : "Microphone access failed");
    }
  }

  return { start, stop, setMuted, sendText, sendLocation, resumePlayback, getAudioLevels };
}
