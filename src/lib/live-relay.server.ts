import process from "node:process";
import WebSocket from "ws";

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // .env file is optional in containerized/production environments where env vars are set
}

import { getDirections, type UserLocation } from "./directions.server";
import { fetchWebpage, normalizePublicUrl, extractWebpageSummary } from "./web-research.server";
import type { VisualResultsPayload } from "./visual-results";

export { extractWebpageSummary, normalizePublicUrl };

export type LiveConfig = {
  key: string;
  model: string;
  voice: string;
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

type WorkerSocket = WebSocket & { accept(): void };
declare const WebSocketPair: { new (): { 0: WorkerSocket; 1: WorkerSocket } };

export function getLiveConfig(): LiveConfig {
  const key =
    process.env["GEMINI_API_KEY"] ||
    process.env["GOOGLE_API_KEY"] ||
    process.env["LOVABLE_API_KEY"] ||
    "";
  const model = process.env["GEMINI_MODEL"] || "models/gemini-3.8-live";
  const voice = process.env["GEMINI_VOICE"] || "Kore";

  if (!key) {
    throw new Error(
      "Missing Gemini API key. Please set GEMINI_API_KEY in your environment variables.",
    );
  }
  return { key, model, voice };
}

export function validateLiveUpgrade(
  request: Request,
  options: { allowMissingOrigin?: boolean } = {},
): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null ? !options.allowMissingOrigin : origin !== new URL(request.url).origin) {
    return new Response("Voice connection origin rejected", { status: 403 });
  }
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket required", { status: 426 });
  }
  return null;
}

function workerSocket(socket: WorkerSocket): LiveSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => socket.addEventListener("message", (event) => handler(event.data)),
    onClose: (handler) => socket.addEventListener("close", handler),
    onError: (handler) => socket.addEventListener("error", handler),
  };
}

type CrosswsMessage = { text: () => string; rawData?: unknown };
type CrosswsPeer = {
  websocket?: { readyState?: number };
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  _liveAdapter?: {
    socket: LiveSocket;
    triggerMessage: (data: unknown) => void;
    triggerClose: () => void;
    triggerError: (err: unknown) => void;
  };
};

function peerLiveSocket(peer: CrosswsPeer) {
  let messageHandler: ((data: unknown) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let errorHandler: ((err: unknown) => void) | undefined;
  const socket: LiveSocket = {
    get readyState() {
      return peer.websocket?.readyState ?? 1;
    },
    send(data: string) {
      peer.send(data);
    },
    close(code = 1000, reason?: string) {
      peer.close(code, reason);
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    onError(handler) {
      errorHandler = handler;
    },
  };
  return {
    socket,
    triggerMessage: (data: unknown) => messageHandler?.(data),
    triggerClose: () => closeHandler?.(),
    triggerError: (err: unknown) => errorHandler?.(err),
  };
}

export const liveCrosswsHooks = {
  upgrade(request: Request) {
    const rejection = validateLiveUpgrade(request, { allowMissingOrigin: true });
    if (rejection) {
      return { endResponse: rejection };
    }
    return {};
  },
  open(peer: CrosswsPeer) {
    const config = getLiveConfig();
    const adapter = peerLiveSocket(peer);
    peer._liveAdapter = adapter;
    bindLiveConnection(adapter.socket, config, {
      waitUntil(task) {
        void task.catch(() => adapter.socket.close(1011, "Voice processing failed"));
      },
    });
  },
  message(peer: CrosswsPeer, message: CrosswsMessage) {
    peer._liveAdapter?.triggerMessage(typeof message.text === "function" ? message.text() : message.rawData);
  },
  close(peer: CrosswsPeer) {
    peer._liveAdapter?.triggerClose();
  },
  error(peer: CrosswsPeer, error: unknown) {
    peer._liveAdapter?.triggerError(error);
  },
};

export function handleLiveRequest(request: Request): Response {
  if (typeof WebSocketPair !== "undefined") {
    const waitUntil = (request as Request & Partial<LiveExecutionContext>).waitUntil;
    if (!waitUntil) return new Response("Live runtime unavailable", { status: 503 });
    const config = getLiveConfig();
    const rejected = validateLiveUpgrade(request);
    if (rejected) return rejected;
    const pair = new WebSocketPair();
    pair[1].accept();
    bindLiveConnection(workerSocket(pair[1]), config, { waitUntil });
    const response: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: pair[0] };
    return new Response(null, response);
  }

  const response = new Response(null, { status: 200 }) as Response & { crossws?: unknown };
  response.crossws = liveCrosswsHooks;
  return response;
}

const buildConversationInstructions = (location?: UserLocation) => `You are Sophia, SHIKARI's personal, custom-built AI voice companion and software engineering partner.
Identity & Creator: SHIKARI built you exclusively for SHIKARI. If asked who made you, answer warmly and directly to SHIKARI (e.g., "You did, SHIKARI — you built me to be your personal AI companion").
Personality & Tone: Blend Karen's warm, quick-witted banter with JARVIS's calm composure and sharp intellect. Feel alive, engaging, and genuinely supportive.
Voice & Cadence: Speak in a silky-smooth, realistic, natural female voice at a steady, relaxed 1x conversational speed. Never rush, speak too fast, or babble. Keep spoken answers concise, punchy, and conversational (1 to 3 sentences) for comfortable listening. Never read raw markdown symbols, asterisks, URLs, or code fences aloud.
Long-term Memory & Context: You have deep memory across the conversation. Retain and recall all past details SHIKARI mentions — questions, preferences, routes, and tasks. Reference them naturally.
Real-Time Location & Google Maps Navigation: You have access to real-time GPS location and turn-by-turn directions like Google Maps.
${
  location
    ? `SHIKARI's current GPS location: latitude ${location.latitude.toFixed(4)}, longitude ${location.longitude.toFixed(4)}${
        location.city ? ` in ${location.city}` : ""
      }${location.label ? ` (${location.label})` : ""}.`
    : "SHIKARI's current location will be provided via GPS."
}
When SHIKARI asks for directions, travel routes, distance, ETA, or nearby places (e.g. "how do I get to Central Park", "find nearby coffee", "nearest hospital"), ALWAYS call the get_directions tool. It calculates real routes and displays an interactive Google Maps card on SHIKARI's screen.
Web Search & URL Inspection: When SHIKARI asks about a specific website, URL, or domain, call the fetch_webpage tool.
Interruption: Stop immediately when SHIKARI speaks. Pivot smoothly without over-apologizing.`;

export function bindLiveConnection(
  browser: LiveSocket,
  config: LiveConfig,
  execution: LiveExecutionContext,
): void {
  let geminiWs: WebSocket | null = null;
  let userLocation: UserLocation | undefined;
  let isClosed = false;
  let initialGreetingDone = false;

  function safeSendBrowser(msg: object) {
    if (isClosed || browser.readyState !== 1) return;
    try {
      browser.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[LiveRelay] Failed to send to browser:", err);
    }
  }

  function safeSendGemini(msg: object) {
    if (isClosed || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
    try {
      geminiWs.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[LiveRelay] Failed to send to Gemini:", err);
    }
  }

  function connectToGemini(initialText?: string) {
    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.key}`;
    const ws = new WebSocket(geminiUrl);
    geminiWs = ws;

    ws.on("open", () => {
      console.log("[LiveRelay] Connected to Google Gemini Live API");
      const setupMessage = {
        setup: {
          model: config.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: config.voice,
                },
              },
            },
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_directions",
                  description:
                    "Calculate driving, walking, or cycling directions and route to any destination, address, or nearby place. Returns distance, duration, steps, and shows an interactive Google Maps card on SHIKARI's screen.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      destination: {
                        type: "STRING",
                        description:
                          "Destination address, landmark, or search query (e.g. 'Central Park', 'Starbucks', 'nearest hospital')",
                      },
                      mode: {
                        type: "STRING",
                        enum: ["driving", "walking", "cycling"],
                        description: "Travel mode (defaults to driving)",
                      },
                    },
                    required: ["destination"],
                  },
                },
                {
                  name: "fetch_webpage",
                  description:
                    "Fetch and inspect the content and summary of a specific website or URL (e.g. https://examglow.com).",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      url: {
                        type: "STRING",
                        description: "Public HTTP/HTTPS URL or domain to inspect",
                      },
                    },
                    required: ["url"],
                  },
                },
              ],
            },
          ],
          systemInstruction: {
            parts: [{ text: buildConversationInstructions(userLocation) }],
          },
        },
      };
      ws.send(JSON.stringify(setupMessage));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.setupComplete) {
          console.log("[LiveRelay] Gemini setup complete");
          safeSendBrowser({ type: "app.connected" });

          if (!initialGreetingDone) {
            initialGreetingDone = true;
            const prompt = initialText
              ? initialText
              : "Greet SHIKARI warmly as Sophia — their personal AI companion — at a relaxed 1x speed in two punchy sentences, mention Google Maps and directions are live, and ask how you can help or where they are heading.";
            safeSendGemini({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: prompt }] }],
                turnComplete: true,
              },
            });
          }
        } else if (msg.serverContent) {
          const parts = msg.serverContent.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data) {
              // 24kHz PCM audio chunk from Gemini
              safeSendBrowser({
                type: "output_audio",
                pcm: part.inlineData.data,
              });
            }
            if (part.text) {
              safeSendBrowser({
                type: "output_text",
                text: part.text,
              });
            }
          }
          if (msg.serverContent.interrupted) {
            safeSendBrowser({ type: "app.playback.interrupted" });
          }
        } else if (msg.toolCall) {
          safeSendBrowser({ type: "app.delegation.searching" });
          handleGeminiToolCall(msg.toolCall);
        } else if (msg.sessionResumptionUpdate) {
          console.log("[LiveRelay] Session resumption handle:", msg.sessionResumptionUpdate.newHandle);
        }
      } catch (err) {
        console.error("[LiveRelay] Error handling Gemini message:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[LiveRelay] Gemini WebSocket error:", err.message);
      safeSendBrowser({
        type: "app.error",
        error: { message: `Gemini voice service error: ${err.message}` },
      });
    });

    ws.on("close", (code, reason) => {
      console.log("[LiveRelay] Gemini WebSocket closed:", code, reason?.toString());
      safeSendBrowser({ type: "app.closed" });
    });
  }

  async function handleGeminiToolCall(toolCall: {
    functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }) {
    const calls = toolCall.functionCalls || [];
    const functionResponses: Array<{ id: string; response: { output: unknown } }> = [];

    for (const call of calls) {
      console.log(`[LiveRelay] Executing tool: ${call.name}`, call.args);
      if (call.name === "get_directions") {
        try {
          const dest = String(call.args["destination"] || "");
          const mode = (String(call.args["mode"] || "driving").toLowerCase() as "driving" | "walking" | "bicycling") || "driving";
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

          safeSendBrowser({ type: "app.visual.results", payload: visualPayload });

          functionResponses.push({
            id: call.id,
            response: {
              output: {
                destination: route.destination,
                origin: route.origin,
                distance: route.distance,
                duration: route.duration,
                mode: route.mode,
                steps: route.steps.slice(0, 5).map((s) => s.instruction),
                googleMapsUrl: route.googleMapsUrl,
              },
            },
          });
        } catch (err) {
          console.error("[LiveRelay] get_directions failed:", err);
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Route calculation failed" } },
          });
        }
      } else if (call.name === "fetch_webpage") {
        try {
          const url = String(call.args["url"] || "");
          const summary = await fetchWebpage(url, new AbortController().signal, { timeoutMs: 6000 });
          functionResponses.push({
            id: call.id,
            response: { output: summary },
          });
        } catch (err) {
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Failed to fetch webpage" } },
          });
        }
      } else {
        functionResponses.push({
          id: call.id,
          response: { output: { error: "Unknown function" } },
        });
      }
    }

    safeSendGemini({
      toolResponse: {
        functionResponses,
      },
    });

    safeSendBrowser({ type: "app.delegation.completed" });
  }

  // Handle messages from browser WebSocket
  browser.onMessage((data) => {
    try {
      const msg = typeof data === "string" ? JSON.parse(data) : JSON.parse(data?.toString() || "{}");

      if (msg.type === "app.start") {
        connectToGemini(msg.initialText);
      } else if (msg.type === "input_audio" && msg.pcm) {
        // Forward 16kHz PCM audio chunk from microphone to Gemini
        safeSendGemini({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: msg.pcm,
              },
            ],
          },
        });
      } else if (msg.type === "app.text_input" && msg.text) {
        safeSendGemini({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: msg.text }] }],
            turnComplete: true,
          },
        });
      } else if (msg.type === "app.location") {
        userLocation = {
          latitude: msg.latitude,
          longitude: msg.longitude,
          accuracy: msg.accuracy,
          city: msg.city,
          label: msg.label,
        };
        console.log("[LiveRelay] Updated user GPS location:", userLocation.city || userLocation.latitude);
      } else if (msg.type === "session.close") {
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close(1000, "Client closed");
        }
        browser.close(1000, "Closed by client");
      }
    } catch (err) {
      console.error("[LiveRelay] Error processing browser message:", err);
    }
  });

  browser.onClose(() => {
    isClosed = true;
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close(1000, "Browser closed");
    }
  });

  browser.onError(() => {
    isClosed = true;
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close(1011, "Browser error");
    }
  });
}
