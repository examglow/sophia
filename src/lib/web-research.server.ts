import {
  GatewayError,
  streamResponse,
  type ResponseFor,
  type ResponsesFieldsByModel,
} from "@lovable.dev/ai-gateway";

import {
  extractDomain,
  extractYouTubeVideoId,
  type VisualResultItem,
  type VisualResultKind,
  type VisualResultsPayload,
} from "./visual-results";

export const BACKEND_MODEL = "openai/gpt-6.1-sol" as const;
export type BackendModel = typeof BACKEND_MODEL;
export type BackendInputItem = Exclude<
  NonNullable<ResponsesFieldsByModel[BackendModel]["input"]>,
  string
>[number];
type BackendResponse = ResponseFor<"responses", BackendModel>;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  const m172 = /^172\.(\d+)\./.exec(host);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^(?:fc|fd|fe80):/i.test(host)) return true;
  return false;
}

export function normalizePublicUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("URL is empty");
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : trimmed.includes("://")
      ? trimmed
      : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https URLs are supported");
  }
  if (!parsed.hostname || !parsed.hostname.includes(".") || isPrivateHost(parsed.hostname)) {
    throw new Error("Private or invalid host is not allowed");
  }
  return parsed;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    });
}

function readMetaContent(html: string, attr: "name" | "property", key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = new RegExp(
    `<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
    "i",
  ).exec(html)?.[1];
  if (direct) return decodeHtmlEntities(direct).replace(/\s+/g, " ").trim();
  const reversed = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${escaped}["']`,
    "i",
  ).exec(html)?.[1];
  return reversed ? decodeHtmlEntities(reversed).replace(/\s+/g, " ").trim() : "";
}

function extractJsonLdSummary(html: string): string {
  const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const parts: string[] = [];
  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof parsed["name"] === "string" ? parsed["name"] : "";
      const headline = typeof parsed["headline"] === "string" ? parsed["headline"] : "";
      const desc = typeof parsed["description"] === "string" ? parsed["description"] : "";
      const chunk = [headline || name, desc].filter(Boolean).join(" — ");
      if (chunk) parts.push(chunk);
    } catch {
      // Ignore malformed JSON-LD blocks
    }
    if (parts.length >= 2) break;
  }
  return parts.join(" | ").slice(0, 600);
}

function resolveOptionalImageUrl(raw: string, baseUrl: string): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    return normalizePublicUrl(new URL(raw.trim(), baseUrl).href).href;
  } catch {
    return undefined;
  }
}

export function extractWebpageSummary(html: string, url: string) {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const title =
    decodeHtmlEntities(titleTag).replace(/\s+/g, " ").trim() ||
    readMetaContent(html, "property", "og:title") ||
    readMetaContent(html, "name", "twitter:title");
  const description =
    readMetaContent(html, "name", "description") ||
    readMetaContent(html, "property", "og:description") ||
    readMetaContent(html, "name", "twitter:description");
  const rawImage =
    readMetaContent(html, "property", "og:image") ||
    readMetaContent(html, "name", "twitter:image");
  const imageUrl = resolveOptionalImageUrl(rawImage, url);
  const siteName = readMetaContent(html, "property", "og:site_name");
  const jsonLd = extractJsonLdSummary(html);
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const bodyText = decodeHtmlEntities(cleaned).replace(/\s+/g, " ").trim();
  const excerpt = [bodyText, jsonLd && !bodyText.includes(jsonLd) ? jsonLd : ""]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 3500);
  return {
    url,
    title,
    description,
    ...(imageUrl ? { imageUrl } : {}),
    ...(siteName ? { siteName } : {}),
    excerpt,
  };
}

function createTimeoutSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function fetchWebpage(
  rawUrl: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; maxBytes?: number } = {},
) {
  let current = normalizePublicUrl(rawUrl);
  const timeout = createTimeoutSignal(signal, options.timeoutMs ?? 10_000);
  const maxBytes = options.maxBytes ?? 240_000;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: timeout.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return { ok: false, url: current.href, status: res.status, error: "Empty redirect" };
        }
        current = normalizePublicUrl(new URL(location, current).href);
        continue;
      }
      if (!res.ok) {
        return { ok: false, url: current.href, status: res.status, error: `HTTP ${res.status}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      let rawText = "";
      if (reader) {
        const decoder = new TextDecoder();
        let bytes = 0;
        while (bytes < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          rawText += decoder.decode(value, { stream: true });
        }
        rawText += decoder.decode();
        void reader.cancel().catch(() => {});
      } else {
        rawText = (await res.text()).slice(0, maxBytes);
      }
      if (
        contentType.includes("text/html") ||
        rawText.includes("<html") ||
        rawText.includes("<title") ||
        rawText.includes("<meta")
      ) {
        return { ok: true, status: res.status, ...extractWebpageSummary(rawText, current.href) };
      }
      return {
        ok: true,
        status: res.status,
        url: current.href,
        title: "",
        description: "",
        excerpt: rawText.replace(/\s+/g, " ").trim().slice(0, 3500),
      };
    }
    return { ok: false, url: current.href, error: "Too many redirects" };
  } finally {
    timeout.cleanup();
  }
}

function fetchWebpageArguments(value: unknown): { url: string } {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !value.url.trim()
  ) {
    throw new Error("Invalid fetch_webpage arguments");
  }
  return { url: value.url.trim() };
}

export function sanitizeVisualResultsInput(value: unknown): VisualResultsPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid show_visual_results arguments");
  }
  const record = value as Record<string, unknown>;
  const heading =
    typeof record["heading"] === "string" && record["heading"].trim()
      ? record["heading"].trim().slice(0, 90)
      : "Visual results";
  const queryLabel =
    typeof record["query_label"] === "string" && record["query_label"].trim()
      ? record["query_label"].trim().slice(0, 120)
      : undefined;
  const rawItems = Array.isArray(record["items"]) ? record["items"] : [];
  const items: VisualResultItem[] = [];

  for (let i = 0; i < rawItems.length && items.length < 6; i++) {
    const entry = rawItems[i];
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const title = typeof row["title"] === "string" ? row["title"].trim().slice(0, 120) : "";
    if (!title) continue;
    const rawKind = row["kind"];
    let kind: VisualResultKind =
      rawKind === "video" || rawKind === "code" || rawKind === "link" ? rawKind : "link";
    const subtitle =
      typeof row["subtitle"] === "string" && row["subtitle"].trim()
        ? row["subtitle"].trim().slice(0, 220)
        : undefined;
    const code =
      typeof row["code"] === "string" && row["code"].trim()
        ? row["code"].slice(0, 4000)
        : undefined;
    const language =
      typeof row["language"] === "string" && row["language"].trim()
        ? row["language"].trim().slice(0, 32)
        : undefined;

    let url: string | undefined;
    if (typeof row["url"] === "string" && row["url"].trim()) {
      try {
        url = normalizePublicUrl(row["url"]).href;
      } catch {
        url = undefined;
      }
    }

    if (kind !== "code" && !url) continue;
    if (kind === "code" && !code) continue;

    let imageUrl: string | undefined;
    if (typeof row["image_url"] === "string" && row["image_url"].trim()) {
      try {
        imageUrl = normalizePublicUrl(row["image_url"]).href;
      } catch {
        imageUrl = undefined;
      }
    }

    if (url) {
      const ytId = extractYouTubeVideoId(url);
      if (ytId) {
        kind = "video";
        imageUrl = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
      }
    }

    const domain = url ? extractDomain(url) : undefined;
    items.push({
      id: `vis-${i}-${items.length}`,
      kind,
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(url ? { url } : {}),
      ...(domain ? { domain } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(code ? { code } : {}),
      ...(language ? { language } : {}),
    });
  }

  if (items.length === 0) {
    throw new Error("show_visual_results requires at least one valid item");
  }
  return {
    heading,
    ...(queryLabel ? { queryLabel } : {}),
    items,
  };
}

async function enrichVisualResults(
  payload: VisualResultsPayload,
  signal: AbortSignal,
): Promise<VisualResultsPayload> {
  const toEnrich = payload.items
    .filter((item) => item.kind !== "code" && item.url && !item.imageUrl)
    .slice(0, 3);
  if (toEnrich.length === 0) return payload;

  const discovered = new Map<string, string>();
  await Promise.all(
    toEnrich.map(async (item) => {
      if (!item.url || signal.aborted) return;
      try {
        const page = await fetchWebpage(item.url, signal, { timeoutMs: 2_500, maxBytes: 80_000 });
        if (page.ok && "imageUrl" in page && typeof page.imageUrl === "string" && page.imageUrl) {
          discovered.set(item.id, page.imageUrl);
        }
      } catch {
        // Best-effort thumbnail enrichment only; never fail search over a missing preview image.
      }
    }),
  );

  if (discovered.size === 0) return payload;
  return {
    ...payload,
    items: payload.items.map((item) => {
      const found = discovered.get(item.id);
      return found ? { ...item, imageUrl: found } : item;
    }),
  };
}

export function filterReplayableOutput(
  output: BackendResponse["output"],
): BackendInputItem[] {
  const kept: BackendInputItem[] = [];
  for (const item of output) {
    if (item.type === "message" || item.type === "reasoning" || item.type === "function_call") {
      kept.push(item);
      continue;
    }
    if (item.type === "web_search_call" && item.status === "completed") {
      kept.push(item);
    }
  }
  return kept;
}

export async function answerEngineeringQuestion(params: {
  history: BackendInputItem[];
  backendModel: BackendModel;
  correlation: { runID: string; sessionID: string; delegationID: string };
  signal: AbortSignal;
  takeNewInputs: () => BackendInputItem[];
  onSearching: () => void;
  onVisualResults: (payload: VisualResultsPayload) => void;
}): Promise<{ answer: string; committedHistory: BackendInputItem[] }> {
  const { history, backendModel, correlation, signal, takeNewInputs, onSearching, onVisualResults } =
    params;
  const working: BackendInputItem[] = [...history];
  let searchAnnounced = false;

  const announceSearch = () => {
    if (searchAnnounced) return;
    searchAnnounced = true;
    onSearching();
  };

  for (let step = 0; step < 8; step++) {
    signal.throwIfAborted();
    const fresh = takeNewInputs();
    if (fresh.length > 0) working.push(...fresh);

    const stream = await streamResponse(
      {
        model: backendModel,
        input: working,
        instructions:
          "You are the engineering research, web search, and visual results engine behind AETHER, SHIKARI's personal voice and text coding companion built by SHIKARI exclusively for SHIKARI. " +
          "Never claim OpenAI or any other company built AETHER; SHIKARI built AETHER. " +
          "Transcripts may be fragmented or corrected; always honor the latest correction. " +
          "Use web_search for web research, videos, tutorials, documentation, package versions, changelogs, errors, news, and current facts. " +
          "Use fetch_webpage ONLY when SHIKARI explicitly mentions a specific website, domain, or URL (e.g., calvras.com, examglow.com) or when you need to inspect a specific page's content directly. " +
          "VISUAL RESULTS RULE: Whenever SHIKARI asks to show something ('show me', 'find me videos', 'pull up', 'search for videos/tutorials/repos/articles/docs/examples'), or when web_search finds visual or browsable links (like YouTube videos, official docs, GitHub repos, or websites worth opening), ALWAYS call show_visual_results with the real verified URLs before giving your final spoken summary. " +
          "Never invent or guess URLs — every URL in show_visual_results must come from web_search or fetch_webpage. " +
          "Your final text response is ONLY spoken aloud by AETHER (never shown as text on screen), so return crisp, natural spoken prose (at most 120 words) with no markdown bold, no bullets, no raw URLs, and no code fences. If you showed visual cards, briefly refer to them naturally ('I pulled up a few videos for you...').",
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
        tools: [
          { type: "web_search", external_web_access: true, search_context_size: "medium" },
          {
            type: "function",
            name: "fetch_webpage",
            parameters: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  description:
                    "Public HTTP/HTTPS URL or domain name to fetch live (e.g. https://calvras.com).",
                },
              },
              required: ["url"],
              additionalProperties: false,
            },
            strict: true,
          },
          {
            type: "function",
            name: "show_visual_results",
            parameters: {
              type: "object",
              properties: {
                heading: {
                  type: "string",
                  description:
                    "Short 2-6 word heading for the visual cards (e.g. 'Helpful videos', 'React 19 docs').",
                },
                query_label: {
                  type: "string",
                  description: "Brief label summarizing what SHIKARI asked for.",
                },
                items: {
                  type: "array",
                  minItems: 1,
                  maxItems: 6,
                  items: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["video", "link", "code"] },
                      title: { type: "string" },
                      subtitle: { type: ["string", "null"] },
                      url: { type: ["string", "null"] },
                      image_url: { type: ["string", "null"] },
                      code: { type: ["string", "null"] },
                      language: { type: ["string", "null"] },
                    },
                    required: [
                      "kind",
                      "title",
                      "subtitle",
                      "url",
                      "image_url",
                      "code",
                      "language",
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: ["heading", "query_label", "items"],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      },
      {
        signal,
        runId: correlation.runID,
        metadata: {
          live_session_id: correlation.sessionID,
          delegation_id: correlation.delegationID,
        },
      },
    );

    let completed: BackendResponse | undefined;
    let incompleteReason: string | undefined;

    for await (const event of stream) {
      if (
        event.type === "response.web_search_call.in_progress" ||
        event.type === "response.web_search_call.searching"
      ) {
        announceSearch();
      }
      if (event.type === "response.completed") completed = event.response;
      if (event.type === "response.incomplete") {
        incompleteReason = event.response.incomplete_details?.reason ?? "incomplete";
      }
    }

    signal.throwIfAborted();
    if (incompleteReason || !completed || completed.status !== "completed") {
      throw new Error(`Backend response did not complete (${incompleteReason ?? completed?.status ?? "missing"})`);
    }

    working.push(...filterReplayableOutput(completed.output));

    const calls = completed.output.filter((item) => item.type === "function_call");
    if (calls.length > 0) {
      for (const call of calls) {
        signal.throwIfAborted();
        let output: unknown;
        if (call.name === "fetch_webpage") {
          announceSearch();
          try {
            const { url } = fetchWebpageArguments(JSON.parse(call.arguments));
            output = await fetchWebpage(url, signal);
          } catch (err) {
            if (signal.aborted) throw err;
            output = {
              ok: false,
              error: err instanceof Error ? err.message : "Could not load webpage",
            };
          }
        } else if (call.name === "show_visual_results") {
          try {
            const sanitized = sanitizeVisualResultsInput(JSON.parse(call.arguments));
            const enriched = await enrichVisualResults(sanitized, signal);
            onVisualResults(enriched);
            output = { ok: true, displayedCount: enriched.items.length };
          } catch (err) {
            if (signal.aborted) throw err;
            output = {
              ok: false,
              error: err instanceof Error ? err.message : "Could not display visual results",
            };
          }
        } else {
          output = { ok: false, error: "Unsupported tool" };
        }
        working.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        });
      }
      continue;
    }

    const answer = completed.output
      .flatMap((item) =>
        item.type === "message"
          ? item.content.flatMap((part) => (part.type === "output_text" ? [part.text] : []))
          : [],
      )
      .join("\n")
      .trim();
    if (!answer) throw new Error("The backend response had no answer");
    return { answer, committedHistory: working };
  }
  throw new Error("The backend task exceeded its step limit");
}

export function describeLookupError(error: unknown): string {
  if (error instanceof GatewayError) {
    console.error("[AETHER lookup GatewayError]", {
      code: error.code,
      httpStatus: error.httpStatus,
      outcome: error.outcome,
      ids: error.ids,
    });
    if (error.httpStatus === 402) {
      return "AI credits are depleted — please top up credits to use web search.";
    }
    if (error.httpStatus === 429) {
      return "Web search is temporarily rate-limited. Try again in a few seconds.";
    }
    return "Web search hit a temporary service error.";
  }
  console.error("[AETHER lookup error]", error instanceof Error ? error.message : String(error));
  return "Web search ran into a snag. Try asking again.";
}