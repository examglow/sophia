import { useEffect, useRef } from "react";

import type { AudioLevels } from "@/hooks/use-live-voice";

export type SphereMode =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "thinking"
  | "searching"
  | "checkin"
  | "muted"
  | "stopping";

type ReactiveSphereProps = {
  mode: SphereMode;
  canWake: boolean;
  compact?: boolean;
  onWake: () => void;
  getAudioLevels: () => AudioLevels;
};

type LatticePoint = {
  x: number;
  y: number;
  z: number;
  band: number;
  phase: number;
};

function buildLattice(count: number): LatticePoint[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts: LatticePoint[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({
      x: Math.cos(theta) * r,
      y,
      z: Math.sin(theta) * r,
      band: i % 8,
      phase: (i * 0.6180339887) % (Math.PI * 2),
    });
  }
  return pts;
}

const MODE_STYLE: Record<
  SphereMode,
  { hue: number; sat: number; light: number; spin: number; scale: number; ringAlpha: number }
> = {
  idle: { hue: 204, sat: 82, light: 60, spin: 0.22, scale: 0.94, ringAlpha: 0.22 },
  connecting: { hue: 200, sat: 92, light: 66, spin: 1.05, scale: 0.98, ringAlpha: 0.48 },
  listening: { hue: 192, sat: 88, light: 62, spin: 0.42, scale: 1.0, ringAlpha: 0.34 },
  speaking: { hue: 198, sat: 96, light: 72, spin: 0.65, scale: 1.06, ringAlpha: 0.56 },
  thinking: { hue: 46, sat: 92, light: 66, spin: 0.92, scale: 1.02, ringAlpha: 0.52 },
  searching: { hue: 38, sat: 96, light: 66, spin: 1.35, scale: 1.04, ringAlpha: 0.66 },
  checkin: { hue: 178, sat: 94, light: 70, spin: 0.58, scale: 1.05, ringAlpha: 0.5 },
  muted: { hue: 236, sat: 46, light: 54, spin: 0.14, scale: 0.91, ringAlpha: 0.16 },
  stopping: { hue: 218, sat: 36, light: 48, spin: 0.18, scale: 0.88, ringAlpha: 0.14 },
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHue(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
}

export function ReactiveSphere({
  mode,
  canWake,
  compact = false,
  onWake,
  getAudioLevels,
}: ReactiveSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<SphereMode>(mode);
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
    const lattice = buildLattice(240);
    const state = {
      hue: MODE_STYLE[modeRef.current].hue,
      sat: MODE_STYLE[modeRef.current].sat,
      light: MODE_STYLE[modeRef.current].light,
      spin: MODE_STYLE[modeRef.current].spin,
      scale: MODE_STYLE[modeRef.current].scale,
      ringAlpha: MODE_STYLE[modeRef.current].ringAlpha,
      energy: 0,
      voiceOut: 0,
      voiceIn: 0,
      rotY: 0,
      rotX: 0.25,
      bands: [0, 0, 0, 0, 0, 0, 0, 0],
    };

    let size = 360;
    let rafId = 0;
    let lastTime = performance.now();

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = Math.max(72, Math.min(rect.width, rect.height));
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
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

      const effectiveOut = levels.output;
      const effectiveIn = levels.input;
      const rawEnergy = Math.max(effectiveOut * 1.15, effectiveIn * 0.95);
      const synthPulse =
        activeMode === "searching" || activeMode === "thinking"
          ? 0.22 + 0.14 * Math.sin(t * 4.2)
          : activeMode === "connecting"
            ? 0.16 + 0.1 * Math.sin(t * 5.0)
            : activeMode === "speaking"
              ? 0.28 + 0.16 * Math.sin(t * 6.4)
              : activeMode === "checkin"
                ? 0.26 + 0.12 * Math.sin(t * 3.8)
                : 0.05 + 0.03 * Math.sin(t * 1.6);

      const smooth = 1 - Math.exp(-dt * 6.5);
      const fast = 1 - Math.exp(-dt * 14);
      state.hue = lerpHue(state.hue, target.hue, smooth);
      state.sat = lerp(state.sat, target.sat, smooth);
      state.light = lerp(state.light, target.light, smooth);
      state.spin = lerp(state.spin, target.spin, smooth);
      state.scale = lerp(state.scale, target.scale, smooth);
      state.ringAlpha = lerp(state.ringAlpha, target.ringAlpha, smooth);
      state.voiceOut = lerp(state.voiceOut, effectiveOut, fast);
      state.voiceIn = lerp(state.voiceIn, effectiveIn, fast);
      state.energy = lerp(state.energy, Math.max(rawEnergy, synthPulse), fast);

      for (let i = 0; i < 8; i++) {
        const b = levels.bands[i] ?? 0;
        state.bands[i] = lerp(state.bands[i] ?? 0, b, fast);
      }

      if (!reducedMotion) {
        state.rotY += dt * (state.spin + state.energy * 0.85);
        state.rotX = 0.28 * Math.sin(t * 0.45) + state.voiceIn * 0.18;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const baseRadius = size * 0.27 * state.scale * (1 + state.energy * 0.09);
      const h = state.hue;
      const s = state.sat;
      const l = state.light;

      const auraRadius = Math.min(size * 0.49, baseRadius * (1.82 + state.energy * 0.24));
      const aura = ctx.createRadialGradient(cx, cy, baseRadius * 0.15, cx, cy, auraRadius);
      aura.addColorStop(0, `hsla(${h}, ${s}%, ${Math.min(86, l + 16)}%, ${0.34 + state.energy * 0.22})`);
      aura.addColorStop(0.45, `hsla(${h}, ${s}%, ${l}%, ${0.14 + state.energy * 0.12})`);
      aura.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(cx, cy, auraRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let shell = 0; shell < 2; shell++) {
        const shellR = baseRadius * (shell === 0 ? 0.86 : 1.02);
        const segments = 56;
        ctx.beginPath();
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const bandVal = state.bands[i % 8] ?? 0;
          const wave =
            Math.sin(angle * 3 + t * (2.2 + shell * 0.9)) * (0.04 + state.energy * 0.08) +
            Math.cos(angle * 5 - t * (3.1 - shell * 0.7)) * (0.025 + bandVal * 0.09);
          const rad = shellR * (1 + wave);
          const px = cx + Math.cos(angle) * rad;
          const py = cy + Math.sin(angle) * rad;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        const coreGrad = ctx.createRadialGradient(
          cx - shellR * 0.18,
          cy - shellR * 0.2,
          shellR * 0.05,
          cx,
          cy,
          shellR * 1.15,
        );
        const shellHue = (h + (shell === 1 ? 14 : -10) + 360) % 360;
        coreGrad.addColorStop(0, `hsla(${shellHue}, 100%, 92%, ${shell === 0 ? 0.36 : 0.15})`);
        coreGrad.addColorStop(0.55, `hsla(${shellHue}, ${s}%, ${l}%, ${shell === 0 ? 0.24 : 0.11})`);
        coreGrad.addColorStop(1, `hsla(${shellHue}, ${s}%, ${Math.max(30, l - 18)}%, 0)`);
        ctx.fillStyle = coreGrad;
        ctx.fill();
        ctx.strokeStyle = `hsla(${shellHue}, ${s}%, ${Math.min(88, l + 16)}%, ${0.22 + state.energy * 0.28})`;
        ctx.lineWidth = shell === 0 ? 1.3 : 0.85;
        ctx.stroke();
      }

      const ringCount = activeMode === "searching" || activeMode === "connecting" ? 3 : 2;
      for (let r = 0; r < ringCount; r++) {
        ctx.save();
        ctx.translate(cx, cy);
        const tilt = r === 0 ? 0.42 + Math.sin(t * 0.6) * 0.15 : r === 1 ? -0.58 : 1.05;
        ctx.rotate(tilt + state.rotY * (r % 2 === 0 ? 0.35 : -0.48));
        const rx = baseRadius * (1.24 + r * 0.14 + state.energy * 0.08);
        const ry = rx * (0.34 + r * 0.12);
        ctx.strokeStyle = `hsla(${(h + r * 12) % 360}, ${s}%, ${Math.min(86, l + 12)}%, ${state.ringAlpha * (1 - r * 0.18)})`;
        ctx.lineWidth = Math.max(0.7, (r === 0 ? 1.25 : 0.9) * Math.min(1, size / 220));
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        const sparkAngle = t * (1.2 + r * 0.55) * (r % 2 === 0 ? 1 : -1);
        const sx = Math.cos(sparkAngle) * rx;
        const sy = Math.sin(sparkAngle) * ry;
        ctx.fillStyle = `hsla(${(h + 18) % 360}, 100%, 90%, ${0.45 + state.energy * 0.5})`;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.1, (1.8 + state.energy * 1.4) * Math.min(1, size / 240)), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      const cosY = Math.cos(state.rotY);
      const sinY = Math.sin(state.rotY);
      const cosX = Math.cos(state.rotX);
      const sinX = Math.sin(state.rotX);
      const fov = baseRadius * 3.4;
      const dotScale = Math.max(0.45, Math.min(1, size / 300));

      for (let i = 0; i < lattice.length; i++) {
        const p = lattice[i];
        if (!p) continue;
        const bandAmp = state.bands[p.band] ?? 0;
        const ripple =
          1 +
          Math.sin(t * 2.6 + p.phase + p.y * 4) * (0.035 + state.energy * 0.09) +
          bandAmp * 0.18;

        const x0 = p.x * ripple;
        const y0 = p.y * ripple;
        const z0 = p.z * ripple;

        const x1 = x0 * cosY - z0 * sinY;
        const z1 = x0 * sinY + z0 * cosY;
        const y2 = y0 * cosX - z1 * sinX;
        const z2 = y0 * sinX + z1 * cosX;

        const perspective = fov / (fov - z2 * baseRadius);
        const px = cx + x1 * baseRadius * perspective;
        const py = cy + y2 * baseRadius * perspective;
        const depth = (z2 + 1.2) / 2.2;
        const dotRadius = Math.max(
          0.55,
          (1.15 + depth * 1.45 + bandAmp * 1.5) * perspective * 0.85 * dotScale,
        );
        const alpha = Math.max(0.08, Math.min(0.95, 0.16 + depth * 0.62 + state.energy * 0.25));
        const dotHue = (h + p.y * 18 + 360) % 360;

        ctx.fillStyle = `hsla(${dotHue}, ${Math.min(100, s + 8)}%, ${Math.min(94, l + depth * 24)}%, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      const coreSpot = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * 0.44);
      coreSpot.addColorStop(0, `hsla(${h}, 100%, 96%, ${0.44 + state.energy * 0.35})`);
      coreSpot.addColorStop(0.6, `hsla(${h}, ${s}%, ${l + 10}%, ${0.14 + state.energy * 0.14})`);
      coreSpot.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
      ctx.fillStyle = coreSpot;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * 0.44, 0, Math.PI * 2);
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

  const label = canWake ? "Wake AETHER voice assistant" : `AETHER is ${mode}`;

  return (
    <button
      type="button"
      onClick={() => {
        if (canWake) onWake();
      }}
      disabled={!canWake}
      aria-label={label}
      className={`group relative flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default cursor-pointer transition-all duration-500 enabled:hover:scale-[1.03] enabled:active:scale-[0.98] ${
        compact ? "h-24 w-24 sm:h-28 sm:w-28" : "h-[min(74vw,410px)] w-[min(74vw,410px)]"
      }`}
    >
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />
    </button>
  );
}