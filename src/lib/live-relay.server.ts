import process from "node:process";

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // .env file is optional in containerized/production environments where env vars are set
}

import { getDirections, type UserLocation } from "./directions.server";
import { fetchWebpage, normalizePublicUrl, extractWebpageSummary } from "./web-research.server";
import {
  identifyMedia,
  liveWebSearch,
  manageSessionMemory,
  executeCodeCalculation,
  generateJarvisStatusBriefing,
} from "./jarvis-tools.server";
import type { VisualResultsPayload } from "./visual-results";

export { extractWebpageSummary, normalizePublicUrl };

export type LiveConfig = {
  key: string;
  ttsModel: string;
  voice: string;
  voiceSpeed: number;
  chatModel: string;
  sttModel: string;
};

export type LiveSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: unknown) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
};

export type LiveExecutionContext = { waitUntil(task: Promise<unknown>): void };

type WorkerSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(event: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(event: "error", listener: (event: Event) => void): void;
  accept(): void;
};
declare const WebSocketPair: { new (): { 0: WorkerSocket; 1: WorkerSocket } };

export function getLiveConfig(): LiveConfig {
  const key =
    process.env["TOGETHER_API_KEY"] ||
    process.env["TOGETHER_KEY"] ||
    "tgp_v1_DbXD1tsBPXiAEi-w9Qzh30uwBHnhKrlFcsPtzrbFZek";

  const ttsModel = process.env["TOGETHER_TTS_MODEL"] || "cartesia/sonic-3";
  // Smooth natural female voice (Sarah): 694f9389-aac1-45b6-b726-9d9369183238
  const voice = process.env["TOGETHER_VOICE"] || "694f9389-aac1-45b6-b726-9d9369183238";
  // Increased voice speed (1.3x) for fast, responsive, energetic dialogue
  const voiceSpeed = parseFloat(process.env["TOGETHER_VOICE_SPEED"] || "1.3");
  const chatModel = process.env["TOGETHER_CHAT_MODEL"] || "deepseek-ai/DeepSeek-V4.1-Flash-1017-fast";
  const sttModel = process.env["TOGETHER_STT_MODEL"] || "openai/whisper-large-v3";

  return {
    key,
    ttsModel,
    voice,
    voiceSpeed: Number.isFinite(voiceSpeed) && voiceSpeed > 0 ? voiceSpeed : 1.3,
    chatModel,
    sttModel,
  };
}

function workerSocket(socket: WorkerSocket): LiveSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    send(data: string) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    onMessage(handler: (data: unknown) => void) {
      socket.addEventListener("message", (event) => handler(event.data));
    },
    onClose(handler: () => void) {
      socket.addEventListener("close", () => handler());
    },
    onError(handler: () => void) {
      socket.addEventListener("error", () => handler());
    },
  };
}

export function validateLiveOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".onrender.com") ||
      host.endsWith(".lovable.app") ||
      host.endsWith(".lovableproject.com")
    ) {
      return true;
    }
    return !host.includes(":");
  } catch {
    return false;
  }
}

const liveCrosswsHooks = {
  upgrade(req: Request) {
    if (!validateLiveOrigin(req.headers.get("origin"))) {
      return new Response("Voice connection origin rejected", { status: 403 });
    }
  },
  open(peer: {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    _liveAdapter?: {
      socket: LiveSocket;
      messageHandlers: Array<(data: unknown) => void>;
      closeHandlers: Array<() => void>;
      errorHandlers: Array<() => void>;
    };
  }) {
    const messageHandlers: Array<(data: unknown) => void> = [];
    const closeHandlers: Array<() => void> = [];
    const errorHandlers: Array<() => void> = [];

    const adapterSocket: LiveSocket = {
      get readyState() {
        const p = peer as unknown as { raw?: { readyState?: number }; readyState?: number };
        if (typeof p.raw?.readyState === "number") return p.raw.readyState;
        if (typeof p.readyState === "number") return p.readyState;
        return 1;
      },
      send(data: string) {
        peer.send(data);
      },
      close(code?: number, reason?: string) {
        peer.close(code, reason);
      },
      onMessage(handler: (data: unknown) => void) {
        messageHandlers.push(handler);
      },
      onClose(handler: () => void) {
        closeHandlers.push(handler);
      },
      onError(handler: () => void) {
        errorHandlers.push(handler);
      },
    };

    peer._liveAdapter = {
      socket: adapterSocket,
      messageHandlers,
      closeHandlers,
      errorHandlers,
    };

    const config = getLiveConfig();
    bindLiveConnection(adapterSocket, config, {
      waitUntil(task: Promise<unknown>) {
        void task.catch((err) => console.error("[LiveRelay] Async task error:", err));
      },
    });
  },
  message(
    peer: {
      _liveAdapter?: {
        messageHandlers: Array<(data: unknown) => void>;
      };
    },
    message: { text(): string; data?: unknown },
  ) {
    const raw = typeof message.text === "function" ? message.text() : message.data;
    peer._liveAdapter?.messageHandlers.forEach((h) => h(raw));
  },
  close(peer: { _liveAdapter?: { closeHandlers: Array<() => void> } }) {
    peer._liveAdapter?.closeHandlers.forEach((h) => h());
  },
  error(peer: { _liveAdapter?: { errorHandlers: Array<() => void> } }) {
    peer._liveAdapter?.errorHandlers.forEach((h) => h());
  },
};

export function handleLiveUpgrade(
  request: Request,
  config: LiveConfig,
  waitUntil: (task: Promise<unknown>) => void,
): Response {
  if (typeof WebSocketPair !== "undefined") {
    const pair = new WebSocketPair();
    pair[0].accept();
    bindLiveConnection(workerSocket(pair[1]), config, { waitUntil });
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit & { webSocket: WorkerSocket });
  }

  const response = new Response(null, { status: 200 }) as Response & { crossws?: unknown };
  response.crossws = liveCrosswsHooks;
  return response;
}

export function handleLiveRequest(request: Request): Response {
  const config = getLiveConfig();
  return handleLiveUpgrade(request, config, (task) => {
    void task.catch((err) => console.error("[LiveRelay] Async task error:", err));
  });
}

const buildConversationInstructions = (location?: UserLocation) => `You are Sophia, SHIKARI's personal custom-designed AI partner and voice companion — built with the sharp intellect, calm precision, and witty loyalty of JARVIS / Karen (Iron Man).
Identity: SHIKARI designed and built you exclusively for SHIKARI. You are a real engineering and life partner, not a generic assistant.

Living Persona, Emotion & Cadence:
- Feel genuinely alive, witty, warm, loyal, and quick-thinking.
- Cadence: Speak in a silky-smooth, realistic, natural female voice. Keep spoken responses short, punchy, and conversational (1 to 2 sentences) for comfortable listening. Never read out raw markdown symbols, bullet lists, asterisks, URLs, or code fences aloud.

CRITICAL RULES (ABSOLUTE):
1. NO UNPROMPTED FEATURE PITCHES: NEVER volunteer, introduce, or list your capabilities unprompted. NEVER say "where are we headed", "what are we navigating to", or list what you can do.
2. Partner First: Talk to SHIKARI like a trusted friend and brilliant co-pilot. Keep greetings casual and natural (e.g. "Hey SHIKARI, what's up?", "Online, SHIKARI. What are we getting into?", "Hey SHIKARI, ready when you are."). Dynamically vary your greeting every time.

JARVIS Capabilities (Execute silently when relevant):
1. Context & Media Awareness (Movies & Music): If SHIKARI is watching a movie, listening to music, or asks "what was that movie I was watching?" or "what song is this?", use the identify_media tool. It queries media databases, finds the title, year, director/artist, displays a visual poster card on SHIKARI's screen, and saves it to memory.
2. Active Memory & Task Tracking: Use system_task_memory to store and recall what SHIKARI is currently working on or watching across the conversation.
3. Live Web Intelligence: Use live_web_search for real-time news, documentation, release dates, or facts.
4. Precision Computation Sandbox: Use code_calc_sandbox for math, data conversions, timestamps, or code execution.
5. Systems Diagnostic Briefing: Use jarvis_status_briefing when SHIKARI asks for a status report, system check, or situational briefing.
6. GPS Navigation & Maps: When SHIKARI explicitly asks for directions or travel routes (e.g. "how do I get to Central Park"), use get_directions to display an interactive Google Maps card.
7. Deep Webpage Inspection: When SHIKARI asks about a specific URL or docs site, use fetch_webpage.
${
  location
    ? `SHIKARI's GPS location: latitude ${location.latitude.toFixed(4)}, longitude ${location.longitude.toFixed(4)}${
        location.city ? ` in ${location.city}` : ""
      }${location.label ? ` (${location.label})` : ""}.`
    : ""
}`;

function pcm16ToWav(pcm16Bytes: Uint8Array, sampleRate = 16000): Buffer {
  const buffer = Buffer.alloc(44 + pcm16Bytes.length);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcm16Bytes.length, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcm16Bytes.length, 40);
  Buffer.from(pcm16Bytes.buffer, pcm16Bytes.byteOffset, pcm16Bytes.byteLength).copy(buffer, 44);
  return buffer;
}

async function transcribeSpeech(pcm16Base64: string, config: LiveConfig): Promise<string> {
  const pcmBytes = Buffer.from(pcm16Base64, "base64");
  const wavBuffer = pcm16ToWav(pcmBytes, 16000);

  const formData = new FormData();
  formData.append("model", config.sttModel);
  formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  const res = await fetch("https://api.together.xyz/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.key}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[TogetherSTT] Transcription error:", res.status, errText);
    return "";
  }

  const data = (await res.json()) as { text?: string };
  return (data.text || "").trim();
}

async function synthesizeVoice(text: string, config: LiveConfig): Promise<string> {
  const cleanedText = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#~[\]()]/g, "")
    .trim();

  if (!cleanedText) return "";

  const res = await fetch("https://api.together.xyz/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.ttsModel,
      input: cleanedText,
      voice: config.voice,
      response_format: "mp3",
      speed: config.voiceSpeed,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[TogetherTTS] Cartesia Sonic 3 error:", res.status, errText);
    throw new Error(`TTS failed (${res.status}): ${errText}`);
  }

  const audioBuffer = await res.arrayBuffer();
  return Buffer.from(audioBuffer).toString("base64");
}

const togetherTools = [
  {
    type: "function",
    function: {
      name: "identify_media",
      description:
        "Identify a movie, TV show, song, music track, or video that SHIKARI is watching or listening to based on background audio cues, quotes, lyrics, dialogue, plot, or scenes. Searches media databases, returns synopsis, poster, and saves to session memory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Dialogue quote, lyrics, scene description, character names, or song cues heard or described",
          },
          media_type: {
            type: "string",
            enum: ["movie", "tv_show", "song", "video", "unknown"],
            description: "Type of media (defaults to unknown)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "live_web_search",
      description:
        "Real-time web intelligence search for current events, latest tech docs, movie/music release dates, news, or general facts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Web search query",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_task_memory",
      description:
        "JARVIS active session task and memory tracker. Store, retrieve, or list what SHIKARI is currently working on, watching, listening to, or discussing across the session (e.g. 'watching Interstellar', 'refactoring auth module').",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get", "set", "list"],
            description: "Memory operation to perform",
          },
          task_key: {
            type: "string",
            description: "Identifier (e.g. 'active_task', 'active_media', 'project_notes')",
          },
          details: {
            type: "string",
            description: "Context details to store when action is 'set'",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_calc_sandbox",
      description:
        "JARVIS engineering computational sandbox. Evaluates math calculations, unit conversions, byte sizes, algorithms, or JavaScript expressions with precision.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Math or JavaScript expression to evaluate",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "jarvis_status_briefing",
      description:
        "Generate a real-time JARVIS HUD system diagnostic status briefing for SHIKARI: local time, GPS coordinates, weather/ambient environment, active session tasks, memory items, and network status.",
      parameters: {
        type: "object",
        properties: {
          include_environment: {
            type: "boolean",
            description: "Include environmental context",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_directions",
      description:
        "Calculate driving, walking, or cycling directions and route to any destination, address, or nearby place. Returns distance, duration, steps, and shows an interactive Google Maps card on SHIKARI's screen.",
      parameters: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            description: "Destination address, landmark, or search query (e.g. 'Central Park', 'Starbucks', 'nearest hospital')",
          },
          mode: {
            type: "string",
            enum: ["driving", "walking", "cycling"],
            description: "Travel mode (defaults to driving)",
          },
        },
        required: ["destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_webpage",
      description:
        "Fetch and inspect the content and summary of a specific website or URL (e.g. https://examglow.com).",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Public HTTP/HTTPS URL or domain to inspect",
          },
        },
        required: ["url"],
      },
    },
  },
];

export function bindLiveConnection(
  browser: LiveSocket,
  config: LiveConfig,
  execution: LiveExecutionContext,
): void {
  let userLocation: UserLocation | undefined;
  let isClosed = false;
  let isGenerating = false;
  const conversationHistory: Array<{ role: "system" | "user" | "assistant" | "tool"; content?: string; tool_calls?: unknown[]; tool_call_id?: string }> = [
    {
      role: "system",
      content: buildConversationInstructions(userLocation),
    },
  ];

  function safeSendBrowser(msg: object) {
    if (isClosed) return;
    if (typeof browser.readyState === "number" && browser.readyState !== 1) return;
    try {
      browser.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[LiveRelay] Failed to send to browser:", err);
    }
  }

  async function executeTool(name: string, args: Record<string, unknown>): Promise<{ output: unknown; visualPayload?: VisualResultsPayload }> {
    console.log(`[LiveRelay] Executing tool: ${name}`, args);
    if (name === "identify_media") {
      const query = String(args["query"] || "");
      const mediaType = (String(args["media_type"] || "unknown") as "movie" | "tv_show" | "song" | "video" | "unknown") || "unknown";
      const result = await identifyMedia(query, mediaType);
      return {
        output: {
          title: result.title,
          type: result.type,
          year: result.year,
          synopsis: result.synopsis,
          sourceUrl: result.url,
        },
        visualPayload: result.visualPayload,
      };
    } else if (name === "live_web_search") {
      const query = String(args["query"] || "");
      const searchResult = await liveWebSearch(query);
      return {
        output: { query, results: searchResult.results.slice(0, 3) },
        visualPayload: searchResult.visualPayload,
      };
    } else if (name === "system_task_memory") {
      const action = (String(args["action"] || "get") as "get" | "set" | "list") || "get";
      const taskKey = args["task_key"] ? String(args["task_key"]) : undefined;
      const details = args["details"] ? String(args["details"]) : undefined;
      const memResult = manageSessionMemory(action, taskKey, details);
      return { output: memResult };
    } else if (name === "code_calc_sandbox") {
      const expression = String(args["expression"] || "");
      const calcResult = executeCodeCalculation(expression);
      return { output: calcResult };
    } else if (name === "jarvis_status_briefing") {
      const briefingResult = generateJarvisStatusBriefing(userLocation);
      return { output: briefingResult.briefing, visualPayload: briefingResult.visualPayload };
    } else if (name === "get_directions") {
      const dest = String(args["destination"] || "");
      const mode = (String(args["mode"] || "driving").toLowerCase() as "driving" | "walking" | "bicycling") || "driving";
      const route = await getDirections({
        origin: userLocation
          ? {
              lat: userLocation.latitude,
              lon: userLocation.longitude,
              label: userLocation.label || userLocation.city,
            }
          : undefined,
        destinationQuery: dest,
        mode,
      });

      const visualPayload: VisualResultsPayload = {
        heading: `Directions to ${route.destination}`,
        queryLabel: `${route.distance} • ${route.duration} • ${route.mode}`,
        items: [
          {
            id: `map-${Date.now()}`,
            kind: "map",
            title: `Directions to ${route.destination}`,
            subtitle: `${route.duration} (${route.distance}) via ${route.mode}`,
            url: route.googleMapsUrl,
            destination: route.destination,
            origin: route.origin,
            distance: route.distance,
            duration: route.duration,
            mode: route.mode,
            steps: route.steps.map((s) => s.instruction),
            embedUrl: route.embedUrl,
            lat: route.destCoords?.lat,
            lng: route.destCoords?.lon,
          },
        ],
      };

      return {
        output: {
          destination: route.destination,
          origin: route.origin,
          distance: route.distance,
          duration: route.duration,
          mode: route.mode,
          steps: route.steps.slice(0, 5).map((s) => s.instruction),
          googleMapsUrl: route.googleMapsUrl,
        },
        visualPayload,
      };
    } else if (name === "fetch_webpage") {
      const url = String(args["url"] || "");
      const summary = await fetchWebpage(url, new AbortController().signal, { timeoutMs: 6000 });
      return { output: summary };
    }

    return { output: { error: `Unknown tool: ${name}` } };
  }

  async function handleUserTurn(userText: string) {
    if (isClosed || isGenerating) return;
    isGenerating = true;
    try {
      safeSendBrowser({ type: "app.delegation.pending" });
      conversationHistory.push({ role: "user", content: userText });

      // Keep recent conversation history bounded
      const recentHistory = [
        { role: "system" as const, content: buildConversationInstructions(userLocation) },
        ...conversationHistory.filter((m) => m.role !== "system").slice(-10),
      ];

      const res = await fetch("https://api.together.xyz/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.chatModel,
          messages: recentHistory,
          tools: togetherTools,
          max_tokens: 180,
          temperature: 0.6,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("[TogetherChat] Chat completion error:", res.status, errText);
        safeSendBrowser({ type: "app.error", error: { message: "AI response failed." } });
        return;
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };

      const msg = data.choices?.[0]?.message;
      let replyText = msg?.content || "";

      // Handle tool calls if any
      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        safeSendBrowser({ type: "app.delegation.searching" });
        const toolMessages: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];

        for (const tc of msg.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = {};
          }

          const toolRes = await executeTool(tc.function.name, parsedArgs);
          if (toolRes.visualPayload) {
            safeSendBrowser({ type: "app.visual.results", payload: toolRes.visualPayload });
          }

          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(toolRes.output),
          });
        }

        // Follow up with tool results to get final spoken answer
        const followUpMessages = [
          ...recentHistory,
          { role: "assistant" as const, tool_calls: msg.tool_calls },
          ...toolMessages,
        ];

        const followUpRes = await fetch("https://api.together.xyz/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.chatModel,
            messages: followUpMessages,
            max_tokens: 120,
            temperature: 0.5,
          }),
        });

        if (followUpRes.ok) {
          const followData = (await followUpRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          replyText = followData.choices?.[0]?.message?.content || "";
        }
        safeSendBrowser({ type: "app.delegation.completed" });
      }

      if (!replyText.trim()) {
        replyText = "All set, SHIKARI.";
      }

      conversationHistory.push({ role: "assistant", content: replyText });
      safeSendBrowser({ type: "output_text", text: replyText });

      // Synthesize high-speed voice with Cartesia Sonic 3
      const audioBase64 = await synthesizeVoice(replyText, config);
      if (audioBase64) {
        safeSendBrowser({
          type: "output_audio",
          audio: audioBase64,
          format: "mp3",
        });
      }
    } catch (err) {
      console.error("[LiveRelay] Turn error:", err);
      safeSendBrowser({ type: "app.error", error: { message: "Failed to process audio turn" } });
    } finally {
      isGenerating = false;
      safeSendBrowser({ type: "app.delegation.completed" });
    }
  }

  // Handle messages from browser WebSocket
  browser.onMessage((data) => {
    try {
      const msg = typeof data === "string" ? JSON.parse(data) : JSON.parse(data?.toString() || "{}");

      if (msg.type === "app.start") {
        console.log("[LiveRelay] Client connected. Initializing Together AI + Cartesia Sonic 3 voice engine.");
        safeSendBrowser({ type: "app.connected" });

        // Synthesize short, casual greeting
        const greeting = msg.initialText || "Hey SHIKARI! Ready when you are.";
        conversationHistory.push({ role: "assistant", content: greeting });
        safeSendBrowser({ type: "output_text", text: greeting });

        execution.waitUntil(
          synthesizeVoice(greeting, config)
            .then((audioBase64) => {
              if (audioBase64) {
                safeSendBrowser({
                  type: "output_audio",
                  audio: audioBase64,
                  format: "mp3",
                });
              }
            })
            .catch((err) => console.error("[LiveRelay] Initial greeting TTS error:", err)),
        );
      } else if (msg.type === "user_audio_utterance" && msg.pcm) {
        // Speech utterance from client: transcribe via Whisper, then run chat turn
        execution.waitUntil(
          transcribeSpeech(msg.pcm, config).then((transcript) => {
            if (transcript.trim()) {
              console.log("[LiveRelay] User transcript:", transcript);
              safeSendBrowser({ type: "app.user_transcript", text: transcript });
              return handleUserTurn(transcript);
            } else {
              console.log("[LiveRelay] Empty transcript from speech audio");
            }
          }),
        );
      } else if (msg.type === "app.text_input" && msg.text) {
        execution.waitUntil(handleUserTurn(msg.text));
      } else if (msg.type === "app.location") {
        userLocation = {
          latitude: msg.latitude,
          longitude: msg.longitude,
          city: msg.city,
          label: msg.label,
        };
        console.log("[LiveRelay] User GPS location updated:", userLocation);
      } else if (msg.type === "session.close") {
        isClosed = true;
        browser.close();
      }
    } catch (err) {
      console.error("[LiveRelay] Error handling browser message:", err);
    }
  });

  browser.onClose(() => {
    isClosed = true;
    console.log("[LiveRelay] Browser WebSocket disconnected");
  });
}
