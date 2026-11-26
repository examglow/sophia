import { useEffect, useRef } from "react";

import type { AudioLevels } from "@/hooks/use-live-voice";

export type WaveMode =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "thinking"
  | "searching"
  | "checkin"
  | "muted"
  | "stopping";

type ReactiveWaveProps = {
  mode: WaveMode;
  canWake: boolean;
  compact?: boolean;
  onWake: () => void;
  getAudioLevels: () => AudioLevels;
};

type WaveStyle = {
  hue: number;
  sat: number;
  light: number;
  amp: number;
  speed: number;
  glow: number;
  layers: number;
};

const MODE_STYLE: Record<WaveMode, WaveStyle> = {
  idle: { hue: 204, sat: 78, light: 68, amp: 0.1, speed: 0.5, glow: 0.3, layers: 3 },
  connecting: { hue: 200, sat: 92, light: 72, amp: 0.24, speed: 1.55, glow: 0.56, layers: 4 },
  listening: { hue: 192, sat: 86, light: 70, amp: 0.15, speed: 0.85, glow: 0.42, layers: 3 },
  speaking: { hue: 198, sat: 96, light: 78, amp: 0.62, speed: 1.15, glow: 0.9, layers: 5 },
  thinking: { hue: 46, sat: 90, light: 72, amp: 0.3, speed: 1.3, glow: 0.62, layers: 4 },
  searching: { hue: 38, sat: 96, light: 72, amp: 0.46, speed: 1.95, glow: 0.76, layers: 5 },
  checkin: { hue: 178, sat: 92, light: 74, amp: 0.26, speed: 0.95, glow: 0.56, layers: 4 },
  muted: { hue: 236, sat: 38, light: 54, amp: 0.05, speed: 0.28, glow: 0.16, layers: 2 },
  stopping: { hue: 218, sat: 32, light: 48, amp: 0.04, speed: 0.2, glow: 0.12, layers: 2 },
};

const TAU = Math.PI * 2;
const SAMPLES = 190;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHue(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
}

export function ReactiveWave({
  mode,
  canWake,
  compact = false,
  onWake,
  getAudioLevels,
}: ReactiveWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<WaveMode>(mode);
  const audioRef = useRef(getAudioLevels);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    audioRef.current = getAudioLevels;
  }, [getAudioLevels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motion = reducedMotion ? 0.18 : 1;

    const state = {
      hue: MODE_STYLE[modeRef.current].hue,
      sat: MODE_STYLE[modeRef.current].sat,
      light: MODE_STYLE[modeRef.current].light,
      amp: MODE_STYLE[modeRef.current].amp,
      speed: MODE_STYLE[modeRef.current].speed,
      glow: MODE_STYLE[modeRef.current].glow,
      layers: MODE_STYLE[modeRef.current].layers,
      energy: 0,
      voiceOut: 0,
      voiceIn: 0,
      phase: 0,
      bands: [0, 0, 0, 0, 0, 0, 0, 0],
    };

    let rafId = 0;
    let lastTime = performance.now();

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    function drawFrame(now: number) {
      if (!ctx || !canvas) return;
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      const t = now * 0.001;
      const activeMode = modeRef.current;
      const target = MODE_STYLE[activeMode];
      const levels = audioRef.current();

      const rawEnergy = Math.max(levels.output * 1.15, levels.input * 0.95);
      const synthPulse =
        activeMode === "searching"
          ? 0.3 + 0.16 * Math.sin(t * 4.4)
          : activeMode === "thinking"
            ? 0.22 + 0.12 * Math.sin(t * 3.4)
            : activeMode === "connecting"
              ? 0.18 + 0.1 * Math.sin(t * 5)
              : activeMode === "speaking"
                ? 0.3 + 0.16 * Math.sin(t * 6.2)
                : activeMode === "checkin"
                  ? 0.2 + 0.1 * Math.sin(t * 2.6)
                  : 0.04 + 0.025 * Math.sin(t * 1.5);

      const smooth = 1 - Math.exp(-dt * 5.5);
      const fast = 1 - Math.exp(-dt * 13);
      state.hue = lerpHue(state.hue, target.hue, smooth);
      state.sat = lerp(state.sat, target.sat, smooth);
      state.light = lerp(state.light, target.light, smooth);
      state.amp = lerp(state.amp, target.amp, smooth);
      state.speed = lerp(state.speed, target.speed, smooth);
      state.glow = lerp(state.glow, target.glow, smooth);
      state.layers = lerp(state.layers, target.layers, smooth);
      state.voiceOut = lerp(state.voiceOut, levels.output, fast);
      state.voiceIn = lerp(state.voiceIn, levels.input, fast);
      state.energy = lerp(state.energy, Math.max(rawEnergy, synthPulse), fast);
      state.phase += dt * state.speed * motion;

      for (let i = 0; i < 8; i++) {
        const b = levels.bands[i] ?? 0;
        state.bands[i] = lerp(state.bands[i] ?? 0, b, fast);
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const h = state.hue;
      const s = state.sat;
      const l = state.light;

      // Soft halo sitting behind the line.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.32);
      const haloR = Math.max(40, width * 0.42);
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
      halo.addColorStop(0, `hsla(${h}, ${s}%, ${Math.min(86, l + 12)}%, ${0.2 + state.glow * 0.26})`);
      halo.addColorStop(0.5, `hsla(${h}, ${s}%, ${l}%, ${0.07 + state.glow * 0.1})`);
      halo.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, haloR, 0, TAU);
      ctx.fill();
      ctx.restore();

      const layerCount = Math.max(2, Math.round(state.layers));
      const amplitude =
        height * 0.44 * state.amp * (0.42 + state.energy * 1.85) * (reducedMotion ? 0.5 : 1);

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (let layer = 0; layer < layerCount; layer++) {
        const depth = layerCount === 1 ? 0 : layer / (layerCount - 1);
        const dir = layer % 2 === 0 ? 1 : -1;
        const layerAmp = amplitude * (1 - depth * 0.62);
        const f1 = 1.15 + layer * 0.42;
        const f2 = 2.6 + layer * 0.75;
        const f3 = 0.55 + layer * 0.2;
        const drift = state.phase * (1.5 + layer * 0.32) * dir;
        const layerHue = (h + (layer - 1) * 11 + 360) % 360;
        const alpha = (0.5 - depth * 0.3) * (0.5 + state.glow * 0.6);

        const stroke = ctx.createLinearGradient(0, 0, width, 0);
        stroke.addColorStop(0, `hsla(${layerHue}, ${s}%, ${l}%, 0)`);
        stroke.addColorStop(0.16, `hsla(${layerHue}, ${s}%, ${l}%, ${alpha * 0.45})`);
        stroke.addColorStop(0.5, `hsla(${layerHue}, 100%, ${Math.min(94, l + 14)}%, ${alpha})`);
        stroke.addColorStop(0.84, `hsla(${layerHue}, ${s}%, ${l}%, ${alpha * 0.45})`);
        stroke.addColorStop(1, `hsla(${layerHue}, ${s}%, ${l}%, 0)`);

        const trace = () => {
          ctx.beginPath();
          for (let i = 0; i <= SAMPLES; i++) {
            const u = i / SAMPLES;
            const x = u * width;
            const env = Math.pow(Math.sin(Math.PI * u), 0.6);
            const band = state.bands[Math.min(7, Math.floor(u * 8))] ?? 0;
            const w1 = Math.sin(u * TAU * f1 + drift);
            const w2 = Math.sin(u * TAU * f2 - drift * 0.72 + layer * 0.8) * 0.42;
            const w3 = Math.sin(u * TAU * f3 + drift * 0.35) * 0.3;
            const shape = w1 * 0.6 + w2 * 0.3 + w3 * 0.28 + band * 0.55;
            const y = cy + env * layerAmp * shape;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        };

        // Wide blurred pass for the bloom, then the crisp core line.
        ctx.shadowColor = `hsla(${layerHue}, 100%, ${Math.min(88, l + 10)}%, ${0.5 + state.glow * 0.4})`;
        ctx.shadowBlur = 18 + state.glow * 34;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = layer === 0 ? 2.6 : 1.5;
        trace();
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = layer === 0 ? 6.5 : 4;
        trace();
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Bright center dot that swells with the voice.
      const coreR = Math.max(1.5, (2.4 + state.energy * 9) * (1 - state.glow * 0.1));
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.2);
      core.addColorStop(0, `hsla(${h}, 100%, 97%, ${0.5 + state.energy * 0.4})`);
      core.addColorStop(0.45, `hsla(${h}, ${s}%, ${Math.min(90, l + 8)}%, ${0.18 + state.energy * 0.2})`);
      core.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 3.2, 0, TAU);
      ctx.fill();

      ctx.restore();

      rafId = requestAnimationFrame(drawFrame);
    }

    rafId = requestAnimationFrame(drawFrame);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const label = canWake ? "Wake Sophia voice assistant" : `Sophia is ${mode}`;

  return (
    <button
      type="button"
      onClick={() => {
        if (canWake) onWake();
      }}
      disabled={!canWake}
      aria-label={label}
      className={`group relative flex w-full max-w-5xl items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default cursor-pointer transition-opacity duration-500 enabled:hover:opacity-90 ${
        compact ? "h-24" : "h-[min(38vh,300px)]"
      }`}
    >
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />
    </button>
  );
}
