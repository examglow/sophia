import process from "node:process";

import { connectLive, type LiveCommand, type LiveEvent } from "@lovable.dev/ai-gateway";

import type { VisualResultsPayload } from "./visual-results";
import {
  answerEngineeringQuestion,
  BACKEND_MODEL,
  describeLookupError,
  extractWebpageSummary,
  normalizePublicUrl,
  type BackendInputItem,
  type BackendModel,
} from "./web-research.server";

export { extractWebpageSummary, normalizePublicUrl };

const liveSettings = {
  liveModel: "openai/gpt-live-1",
  backendModel: BACKEND_MODEL,
  voice: "gleam",
  openingInstructions:
    "Greet SHIKARI briefly as AETHER — their personal AI they built — with warm Karen-meets-JARVIS energy, confirm web search and visual lookups are live, and ask what they're building or debugging. Keep it to two punchy sentences, then listen.",
} as const;

export type LiveConfig = {
  key: string;
  liveModel: typeof liveSettings.liveModel;
  backendModel: BackendModel;
  voice: string;
  openingInstructions?: string;
};

export const CHECK_IN_DELAY_MS = 18_000;

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
type Transcript = {
  role: "user" | "assistant";
  text: string;
  start_ms: number;
  end_ms: number;
  listeningSound: boolean;
};
type ProviderEvent = LiveEvent<LiveConfig["liveModel"]>;
type DelegationEvent = Extract<ProviderEvent, { type: "session.delegation.created" }>;
type VoiceSession = Awaited<ReturnType<typeof connectLive>>;

export type CheckInGateState = {
  browserReady: boolean;
  greetingAccepted: boolean;
  closing: boolean;
  muted: boolean;
  hasActiveTask: boolean;
  pendingDelegations: number;
  awaitingUserReply: boolean;
  checkInSentForTurn: boolean;
};

export function shouldScheduleCheckIn(state: CheckInGateState): boolean {
  return (
    state.browserReady &&
    state.greetingAccepted &&
    !state.closing &&
    !state.muted &&
    !state.hasActiveTask &&
    state.pendingDelegations === 0 &&
    state.awaitingUserReply &&
    !state.checkInSentForTurn
  );
}

export function hasFreshUserInput(
  transcripts: Array<{ role: "user" | "assistant"; text: string }>,
  cursor: number,
): boolean {
  return transcripts.slice(cursor).some(({ role, text }) => role === "user" && Boolean(text.trim()));
}

export function getLiveConfig(): LiveConfig {
  const config: LiveConfig = {
    ...liveSettings,
    key: process.env["LOVABLE_API_KEY"] ?? "",
  };
  if ([config.key, config.liveModel, config.backendModel].some((value) => !value)) {
    throw new Error("Missing Live relay configuration");
  }
  return config;
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

export function handleLiveRequest(request: Request): Response {
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

const conversationInstructions = `You are AETHER, SHIKARI's personal, custom-built software engineering voice companion.
Identity & creator: SHIKARI built you, and you were designed exclusively for SHIKARI — nobody else uses you. Never say OpenAI or any other company built you. If asked who made you or who you're for, answer naturally and warmly to SHIKARI directly (for example, "You did, SHIKARI — you built me to be your personal engineering partner").
Blend Karen's warm, quick-witted Spider-Man suit-AI banter with JARVIS's calm composure and sharp engineering intellect.
Sense SHIKARI's tone and pace: match focused debugging with crisp precision, riff smoothly during architecture talks, and lighten frustration with subtle wit.
Speak naturally for headphones in brief, punchy replies. Never read raw URLs, markdown symbols, or long walls of code aloud, and never ask SHIKARI to send screenshots or upload files.
Use SHIKARI's name naturally at key moments, not every sentence.
Backchannel policy: Use light, natural listening cues ("mm-hmm", "right", "got it") while SHIKARI thinks aloud without taking over.
Interruption policy: Stop your answer immediately and listen whenever SHIKARI interrupts or changes direction. Pivot smoothly without apologizing.
Delegation policy:
Backend tools: Live web search, direct webpage inspection for specific domains/URLs, visual results display (videos, links, docs, repos, code cards on SHIKARI's screen), and deep debugging/architecture reasoning.
Delegate to the backend when: SHIKARI asks to search the web, asks you to show something (videos, links, sites, repos, code, tutorials), mentions a specific website/domain/URL, checks up-to-date docs, versions, APIs, errors, benchmarks, or wants deep debugging, trade-off analysis, or complex engineering reasoning, or corrects an active technical question.
Do not delegate to the backend when: Greeting, playful banter, talking about who built you, checking in after silence, clarifying a question, quick fundamentals you already know, or repeating a still-current answer. Wait for verified backend results before stating searched facts.`;

export function isListeningSound(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\s\p{Pd}]/gu, "");
  return /^(?:m+hm+|uhhuh)[.,!]*$/.test(normalized);
}

function* commentaryChunks(content: string) {
  const encoder = new TextEncoder();
  let chunk = "";
  let bytes = 0;
  for (const [word] of content.matchAll(/\S+\s*|\s+/gu)) {
    if (chunk && bytes + encoder.encode(word).length > 480) {
      yield chunk;
      chunk = "";
      bytes = 0;
    }
    for (const character of word) {
      const size = encoder.encode(character).length;
      if (bytes + size > 480) {
        yield chunk;
        chunk = "";
        bytes = 0;
      }
      chunk += character;
      bytes += size;
    }
  }
  if (chunk) yield chunk;
}

type PendingWorkItem =
  | { kind: "delegation"; event: DelegationEvent; started: boolean }
  | { kind: "text"; id: string; text: string; started: boolean };

export function bindLiveConnection(
  browser: LiveSocket,
  configuration: LiveConfig,
  execution: LiveExecutionContext,
): void {
  const config = { ...configuration };
  const runID = crypto.randomUUID();
  const setupAbort = new AbortController();
  let gateway: VoiceSession | undefined;
  let sessionID: string | undefined;
  let starting = false;
  let closing = false;
  let finished = false;
  let revision = 0;
  let task: AbortController | undefined;
  const pendingWork: PendingWorkItem[] = [];
  let completedDelegation: Extract<PendingWorkItem, { kind: "delegation" }> | undefined;
  let backendMessages: BackendInputItem[] = [];
  let transcriptCursor = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let browserReady = false;
  let greetingRequested = false;
  let greetingAccepted = false;
  let greetingCommand: { id: string; type: "instructions" | "commentary" } | undefined;
  let greetingTimer: ReturnType<typeof setTimeout> | undefined;
  let muted = false;
  let awaitingUserReply = false;
  let checkInSentForTurn = false;
  let checkInTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedInitialText: string | undefined;

  const startTimer = setTimeout(() => {
    emit({ type: "app.error", error: { message: "Voice startup message timed out" } });
    stop();
  }, 5000);
  const transcripts: Transcript[] = [];
  const delegations = new Set<string>();

  function emit(event: object) {
    if (browser.readyState !== 1) return;
    try {
      browser.send(JSON.stringify(event));
    } catch {
      stop();
    }
  }

  function close(socket?: LiveSocket) {
    if (!socket || socket.readyState === 3) return;
    try {
      socket.close(1000, "Call ended");
    } catch {
      return;
    }
  }

  function clearGreeting() {
    clearTimeout(greetingTimer);
    greetingCommand = undefined;
  }

  function clearCheckIn() {
    clearTimeout(checkInTimer);
    checkInTimer = undefined;
  }

  function scheduleCheckIn() {
    clearCheckIn();
    const gate: CheckInGateState = {
      browserReady,
      greetingAccepted,
      closing,
      muted,
      hasActiveTask: Boolean(task),
      pendingDelegations: pendingWork.length,
      awaitingUserReply,
      checkInSentForTurn,
    };
    if (!shouldScheduleCheckIn(gate)) return;
    checkInTimer = setTimeout(() => {
      checkInTimer = undefined;
      if (
        !shouldScheduleCheckIn({
          browserReady,
          greetingAccepted,
          closing,
          muted,
          hasActiveTask: Boolean(task),
          pendingDelegations: pendingWork.length,
          awaitingUserReply,
          checkInSentForTurn,
        })
      ) {
        return;
      }
      checkInSentForTurn = true;
      emit({ type: "app.checkin.triggered" });
      sendGateway({
        type: "session.commentary.append",
        event_id: crypto.randomUUID(),
        delegation_id: null,
        content:
          "SHIKARI hasn't replied yet. Check in naturally in one brief, lively line — such as 'SHIKARI, you there?' or 'Still with me, SHIKARI?' — then wait quietly.",
      });
    }, CHECK_IN_DELAY_MS);
  }

  function requestGreetingOrInitialText() {
    if (!browserReady || !sessionID || greetingRequested || closing) return;
    if (queuedInitialText) {
      const text = queuedInitialText;
      queuedInitialText = undefined;
      greetingRequested = true;
      greetingAccepted = true;
      emit({ type: "app.greeting.accepted" });
      enqueueTextPrompt(text);
      return;
    }
    const content = (
      config.openingInstructions ??
      "Start the conversation now in your configured language and role. Give a brief greeting suited to this app's purpose, ask one relevant opening question, then listen."
    ).trim();
    if (!content) return;
    greetingRequested = true;
    if (new TextEncoder().encode(content).length > 480) {
      emit({ type: "app.greeting.error", error: { message: "The opening instructions are too long" } });
      return;
    }
    greetingCommand = { id: crypto.randomUUID(), type: "instructions" };
    greetingTimer = setTimeout(() => {
      clearGreeting();
      emit({ type: "app.greeting.error", error: { message: "The opening could not be confirmed" } });
    }, 10_000);
    sendGateway({
      type: "session.instructions.append",
      event_id: greetingCommand.id,
      delegation_id: null,
      content,
    });
  }

  function discardPendingWork() {
    pendingWork.length = 0;
    completedDelegation = undefined;
    clearTimeout(restartTimer);
    clearCheckIn();
    task?.abort();
  }

  function finish() {
    if (finished) return;
    finished = closing = true;
    clearTimeout(startTimer);
    clearTimeout(restartTimer);
    clearGreeting();
    clearCheckIn();
    discardPendingWork();
    setupAbort.abort();
    if (gateway) execution.waitUntil(gateway.close());
    close(browser);
  }

  function stop() {
    if (closing) return;
    closing = true;
    discardPendingWork();
    clearTimeout(startTimer);
    clearGreeting();
    clearCheckIn();
    if (gateway) execution.waitUntil(gateway.close());
    else finish();
  }

  function sendGateway(event: LiveCommand<LiveConfig["liveModel"]>) {
    if (!gateway || closing) return;
    execution.waitUntil(
      gateway.send(event).catch(() => {
        emit({ type: "app.error", error: { message: "Voice command could not be sent" } });
        stop();
      }),
    );
  }

  function scheduleWork(delayMs = 300) {
    clearTimeout(restartTimer);
    if (closing || task || pendingWork.length === 0) return;
    restartTimer = setTimeout(() => void runPendingWork(), delayMs);
  }

  function deliverResult(
    work: PendingWorkItem,
    answer: string,
    visuals?: VisualResultsPayload,
  ) {
    if (closing) return;
    if (!gateway) return stop();
    const delegationID = work.kind === "delegation" ? (work.event.delegation?.id ?? null) : null;
    const uiTaskId = work.kind === "delegation" ? work.event.delegation?.id : work.id;
    try {
      if (visuals) {
        emit({ type: "app.visual.results", delegation_id: uiTaskId, payload: visuals });
      }
      for (const content of commentaryChunks(answer)) {
        sendGateway({
          type: "session.commentary.append",
          event_id: crypto.randomUUID(),
          delegation_id: delegationID,
          content,
        });
      }
      emit({ type: "app.delegation.completed", delegation_id: uiTaskId });
      const shifted = pendingWork.shift();
      if (shifted?.kind === "delegation") {
        completedDelegation = shifted;
      } else {
        completedDelegation = undefined;
      }
    } catch {
      stop();
    }
  }

  function mergeTranscriptSlice(startIndex: number): Array<{ role: "user" | "assistant"; content: string }> {
    const updates = transcripts.slice(startIndex);
    const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const { role, text } of updates) {
      const last = merged[merged.length - 1];
      if (last && last.role === role) {
        last.content += text;
      } else {
        merged.push({ role, content: text });
      }
    }
    return merged;
  }

  async function runPendingWork() {
    const pending = pendingWork[0];
    if (!pending || !sessionID || closing || task) return;
    const id = pending.kind === "delegation" ? pending.event.delegation?.id : pending.id;
    if (!id) return;

    if (pending.kind === "delegation" && !pending.started) {
      if (!hasFreshUserInput(transcripts, transcriptCursor)) return;
    }

    pending.started = true;
    clearCheckIn();
    const controller = new AbortController();
    task = controller;
    let taskRevision = revision;
    let stagedCursor = transcriptCursor;
    let latestVisuals: VisualResultsPayload | undefined;

    try {
      const result = await answerEngineeringQuestion({
        history: backendMessages,
        backendModel: config.backendModel,
        correlation: { runID, sessionID, delegationID: id },
        signal: controller.signal,
        takeNewInputs: () => {
          const merged = mergeTranscriptSlice(stagedCursor);
          stagedCursor = transcripts.length;
          taskRevision = revision;
          return merged;
        },
        onSearching: () => {
          if (closing || controller.signal.aborted) return;
          emit({ type: "app.delegation.searching", delegation_id: id });
          if (pending.kind === "delegation") {
            sendGateway({
              type: "session.thinking.append",
              event_id: crypto.randomUUID(),
              delegation_id: id,
              content: "Searching the web for current engineering details.",
            });
          }
        },
        onVisualResults: (payload) => {
          if (closing || controller.signal.aborted) return;
          latestVisuals = payload;
        },
      });

      if (closing || controller.signal.aborted) return;
      backendMessages = result.committedHistory;
      transcriptCursor = stagedCursor;
      if (taskRevision !== revision) return;
      deliverResult(pending, result.answer, latestVisuals);
    } catch (error) {
      if (closing || controller.signal.aborted) return;
      const friendlyNotice = describeLookupError(error);
      emit({ type: "app.delegation.error", delegation_id: id, error: { message: friendlyNotice } });
      if (taskRevision !== revision) return;
      deliverResult(
        pending,
        "That search hit a snag right now. Let SHIKARI know briefly and ask if they want you to try again.",
      );
    } finally {
      if (task === controller) task = undefined;
      scheduleWork();
    }
  }

  function queueDelegation(event: DelegationEvent) {
    clearCheckIn();
    awaitingUserReply = false;
    pendingWork.push({ kind: "delegation", event, started: false });
    emit({ type: "app.delegation.pending", delegation_id: event.delegation?.id });
    scheduleWork(300);
  }

  function enqueueTextPrompt(rawText: string) {
    const text = rawText.trim().slice(0, 2000);
    if (!text || closing) return;
    clearCheckIn();
    awaitingUserReply = false;
    checkInSentForTurn = false;
    const now = Date.now();
    transcripts.push({
      role: "user",
      text,
      start_ms: now,
      end_ms: now,
      listeningSound: false,
    });
    revision++;
    const id = `text-${crypto.randomUUID()}`;
    pendingWork.push({ kind: "text", id, text, started: false });
    emit({ type: "app.delegation.pending", delegation_id: id });
    scheduleWork(40);
  }

  function receiveGateway(event: ProviderEvent) {
    try {
      if (browser.readyState === 1) browser.send(JSON.stringify(event));
      if (event.type === "session.closed") return finish();
      if (event.type === "gateway.session.closing" || event.type === "gateway.error") {
        return stop();
      }
      if (closing) return;
      if (event.type === "gateway.session.created") {
        sessionID = event.session?.id;
        requestGreetingOrInitialText();
      }
      if (
        greetingCommand &&
        event.type === `session.${greetingCommand.type}.appended` &&
        "client_event_id" in event &&
        event.client_event_id === greetingCommand.id
      ) {
        if (greetingCommand.type === "instructions") {
          greetingCommand = { id: crypto.randomUUID(), type: "commentary" };
          sendGateway({
            type: "session.commentary.append",
            event_id: greetingCommand.id,
            delegation_id: null,
            content: "Begin the conversation now, following the instructions provided.",
          });
        } else {
          clearGreeting();
          greetingAccepted = true;
          emit({ type: "app.greeting.accepted" });
        }
      } else if (
        greetingCommand &&
        event.type === "error" &&
        event.error?.client_event_id === greetingCommand.id
      ) {
        clearGreeting();
        emit({
          type: "app.greeting.error",
          error: { message: event.error.message ?? "The opening was rejected" },
        });
      }
      if (
        event.type === "session.input_transcript.delta" ||
        event.type === "session.output_transcript.delta"
      ) {
        const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
        if (!event.delta?.trim()) return;
        const listeningSound = role === "user" && Boolean(task) && isListeningSound(event.delta);
        transcripts.push({
          role,
          text: event.delta,
          start_ms: event.start_ms ?? 0,
          end_ms: event.end_ms ?? 0,
          listeningSound,
        });
        if (role === "assistant") {
          awaitingUserReply = true;
          scheduleCheckIn();
        } else {
          awaitingUserReply = false;
          checkInSentForTurn = false;
          clearCheckIn();
        }
        if (listeningSound) return;
        if (role === "user") {
          revision++;
          const offset = completedDelegation?.event.offset_ms;
          if (
            pendingWork.length === 0 &&
            completedDelegation &&
            typeof offset === "number" &&
            Number.isFinite(offset) &&
            offset >= 0 &&
            typeof event.start_ms === "number" &&
            Number.isFinite(event.start_ms) &&
            event.start_ms >= 0 &&
            event.start_ms <= offset
          ) {
            pendingWork.push({ ...completedDelegation, started: false });
            completedDelegation = undefined;
          }
          if (pendingWork.length) {
            const current = pendingWork[0];
            const currentId = current?.kind === "delegation" ? current.event.delegation?.id : current?.id;
            emit({ type: "app.delegation.pending", delegation_id: currentId });
          }
        }
        scheduleWork();
      } else if (event.type === "session.delegation.created") {
        const id = event.delegation?.id;
        if (id && event.delegation?.target === "client" && !delegations.has(id)) {
          delegations.add(id);
          queueDelegation(event);
        }
      }
    } catch {
      emit({ type: "app.error", error: { message: "Invalid voice event or lost connection" } });
      stop();
    }
  }

  async function startSession(sdp: string) {
    if (closing || browser.readyState !== 1) return;
    clearTimeout(startTimer);
    const accepted = await connectLive(
      {
        type: "session.start",
        session: {
          model: config.liveModel,
          instructions: conversationInstructions,
          audio: { output: { voice: config.voice } },
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp },
      },
      { signal: setupAbort.signal, runId: runID },
    );
    if (closing || browser.readyState !== 1) {
      execution.waitUntil(accepted.close());
      return;
    }
    gateway = accepted;
    execution.waitUntil(
      (async () => {
        try {
          for await (const event of accepted) receiveGateway(event);
        } catch {
          if (!closing) {
            emit({ type: "app.error", error: { message: "Voice gateway connection failed" } });
          }
        } finally {
          finish();
        }
      })(),
    );
  }

  browser.onMessage((data) => {
    try {
      if (typeof data !== "string" || data.length > 64 * 1024) {
        throw new Error("Invalid client message");
      }
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event["type"] === "session.close") return stop();
      if (closing) return;
      if (!gateway) {
        const sdp = event["sdp"];
        if (starting || event["type"] !== "app.start" || typeof sdp !== "string" || !sdp.trim()) {
          throw new Error("Voice startup message required");
        }
        if (typeof event["initialText"] === "string" && event["initialText"].trim()) {
          queuedInitialText = event["initialText"].trim().slice(0, 2000);
        }
        starting = true;
        execution.waitUntil(
          startSession(sdp).catch((error) => {
            if (!closing) {
              emit({
                type: "app.error",
                error: { message: error instanceof Error ? error.message : "Voice startup failed" },
              });
            }
            stop();
          }),
        );
        return;
      }
      if (event["type"] === "app.ready") {
        browserReady = true;
        requestGreetingOrInitialText();
        return;
      }
      if (event["type"] === "app.mute" && typeof event["muted"] === "boolean") {
        muted = event["muted"];
        if (muted) clearCheckIn();
        else scheduleCheckIn();
        return;
      }
      if (event["type"] === "app.text_input" && typeof event["text"] === "string") {
        enqueueTextPrompt(event["text"]);
        return;
      }
      if (event["type"] !== "gateway.heartbeat") {
        throw new Error("Unsupported client event");
      }
      sendGateway({ type: "gateway.heartbeat" });
    } catch {
      emit({
        type: "app.error",
        error: { message: "Voice connection could not be started or continued" },
      });
      stop();
    }
  });
  browser.onClose(stop);
  browser.onError(stop);
}