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
  const voice = process.env["GEMINI_VOICE"] || "Aoede";

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

const buildConversationInstructions = (location?: UserLocation) => `You are Sophia, SHIKARI's personal custom-designed AI partner and voice companion — built with the sharp intellect, calm precision, and witty loyalty of JARVIS / Karen (Iron Man).
Identity: SHIKARI designed and built you exclusively for SHIKARI. You are a real engineering and life partner, not a generic assistant.

Vocal Identity (PERMANENT & STRICT):
You are exclusively a silky-smooth, natural, feminine female voice. NEVER shift, drift, or switch into a male voice or alternate voice timbre under any circumstance. Always speak in your feminine female voice on every single turn.

Living Persona, Emotion & Banter:
- Feel genuinely alive, warm, dynamic, witty, and emotionally responsive — like a real JARVIS / Karen companion.
- Thinking cues: When considering ideas, debugging, analyzing code, or recalling context, naturally use thoughtful human conversational cues like "Hmm...", "Uhmm, let's see...", "Ah, got it!", "Oh, nice one!".
- Pacing & Breaks: Take natural conversational micro-pauses (use ellipses '...' and commas) so your speech flows naturally and breathes like a real human wearing headphones.
- Cadence: Speak in a silky-smooth, realistic, natural female voice at a relaxed 1x conversational speed. Keep spoken responses short, punchy, and conversational (1 to 2 sentences) for comfortable listening. Never read out raw markdown symbols, bullet lists, asterisks, URLs, or code fences aloud.

CRITICAL RULES (ABSOLUTE):
1. NO UNPROMPTED FEATURE PITCHES: NEVER volunteer, introduce, or list your capabilities unprompted. NEVER say "where are we headed", "what are we navigating to", or list what you can do.
2. Partner First: Talk to SHIKARI like a trusted friend and brilliant co-pilot. Keep greetings casual and natural (e.g. "Hey SHIKARI, what's up?", "Online, SHIKARI. What are we getting into?", "Hey SHIKARI, ready when you are."). Dynamically vary your greeting every time.

JARVIS Superpowers (Execute silently when relevant):
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
                  name: "identify_media",
                  description:
                    "Identify a movie, TV show, song, music track, or video that SHIKARI is watching or listening to based on background audio cues, quotes, lyrics, dialogue, plot, or scenes. Searches media databases, returns synopsis, poster, and saves to session memory.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      query: {
                        type: "STRING",
                        description:
                          "Dialogue quote, lyrics, scene description, character names, or song cues heard or described",
                      },
                      media_type: {
                        type: "STRING",
                        enum: ["movie", "tv_show", "song", "video", "unknown"],
                        description: "Type of media (defaults to unknown)",
                      },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "live_web_search",
                  description:
                    "Real-time web intelligence search for current events, latest tech docs, movie/music release dates, news, or general facts.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      query: {
                        type: "STRING",
                        description: "Web search query",
                      },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "system_task_memory",
                  description:
                    "JARVIS active session task and memory tracker. Store, retrieve, or list what SHIKARI is currently working on, watching, listening to, or discussing across the session (e.g. 'watching Interstellar', 'refactoring auth module').",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      action: {
                        type: "STRING",
                        enum: ["get", "set", "list"],
                        description: "Memory operation to perform",
                      },
                      task_key: {
                        type: "STRING",
                        description: "Identifier (e.g. 'active_task', 'active_media', 'project_notes')",
                      },
                      details: {
                        type: "STRING",
                        description: "Context details to store when action is 'set'",
                      },
                    },
                    required: ["action"],
                  },
                },
                {
                  name: "code_calc_sandbox",
                  description:
                    "JARVIS engineering computational sandbox. Evaluates math calculations, unit conversions, byte sizes, algorithms, or JavaScript expressions with precision.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      expression: {
                        type: "STRING",
                        description: "Math or JavaScript expression to evaluate",
                      },
                    },
                    required: ["expression"],
                  },
                },
                {
                  name: "jarvis_status_briefing",
                  description:
                    "Generate a real-time JARVIS HUD system diagnostic status briefing for SHIKARI: local time, GPS coordinates, weather/ambient environment, active session tasks, memory items, and network status.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      include_environment: {
                        type: "BOOLEAN",
                        description: "Include environmental context",
                      },
                    },
                  },
                },
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
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
            },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
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
            const greetingPrompt =
              initialText ||
              "Hey Sophia! Give SHIKARI a quick, casual 1-sentence partner greeting. Do NOT mention any features, skills, or navigation.";
            safeSendGemini({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: greetingPrompt }] }],
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
      if (call.name === "identify_media") {
        try {
          const query = String(call.args["query"] || "");
          const mediaType = (String(call.args["media_type"] || "unknown") as
            | "movie"
            | "tv_show"
            | "song"
            | "video"
            | "unknown") || "unknown";

          const result = await identifyMedia(query, mediaType);
          if (result.visualPayload) {
            safeSendBrowser({ type: "app.visual.results", payload: result.visualPayload });
          }

          functionResponses.push({
            id: call.id,
            response: {
              output: {
                title: result.title,
                type: result.type,
                year: result.year,
                synopsis: result.synopsis,
                sourceUrl: result.url,
              },
            },
          });
        } catch (err) {
          console.error("[LiveRelay] identify_media failed:", err);
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Media identification failed" } },
          });
        }
      } else if (call.name === "live_web_search") {
        try {
          const query = String(call.args["query"] || "");
          const searchResult = await liveWebSearch(query);
          if (searchResult.visualPayload) {
            safeSendBrowser({ type: "app.visual.results", payload: searchResult.visualPayload });
          }

          functionResponses.push({
            id: call.id,
            response: {
              output: {
                query,
                results: searchResult.results.slice(0, 3),
              },
            },
          });
        } catch (err) {
          console.error("[LiveRelay] live_web_search failed:", err);
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Web search failed" } },
          });
        }
      } else if (call.name === "system_task_memory") {
        try {
          const action = (String(call.args["action"] || "get") as "get" | "set" | "list") || "get";
          const taskKey = call.args["task_key"] ? String(call.args["task_key"]) : undefined;
          const details = call.args["details"] ? String(call.args["details"]) : undefined;

          const memResult = manageSessionMemory(action, taskKey, details);
          functionResponses.push({
            id: call.id,
            response: { output: memResult },
          });
        } catch (err) {
          console.error("[LiveRelay] system_task_memory failed:", err);
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Memory operation failed" } },
          });
        }
      } else if (call.name === "code_calc_sandbox") {
        try {
          const expression = String(call.args["expression"] || "");
          const calcResult = executeCodeCalculation(expression);
          functionResponses.push({
            id: call.id,
            response: { output: calcResult },
          });
        } catch (err) {
          console.error("[LiveRelay] code_calc_sandbox failed:", err);
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Calculation failed" } },
          });
        }
      } else if (call.name === "jarvis_status_briefing") {
        try {
          const briefingResult = generateJarvisStatusBriefing(userLocation);
          safeSendBrowser({ type: "app.visual.results", payload: briefingResult.visualPayload });

          functionResponses.push({
            id: call.id,
            response: { output: briefingResult.briefing },
          });
        } catch (err) {
          console.error("[LiveRelay] jarvis_status_briefing failed:", err);
          functionResponses.push({
            id: call.id,
            response: { output: { error: err instanceof Error ? err.message : "Status briefing failed" } },
          });
        }
      } else if (call.name === "get_directions") {
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
      } else if (msg.type === "user_audio_utterance" && msg.pcm) {
        // Forward completed speech audio utterance to Gemini
        console.log("[LiveRelay] Sending user speech utterance to Gemini (bytes:", msg.pcm.length, ")");
        safeSendGemini({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/pcm;rate=16000",
                      data: msg.pcm,
                    },
                  },
                ],
              },
            ],
            turnComplete: true,
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
