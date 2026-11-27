import vm from "node:vm";
import type { UserLocation } from "./directions.server";
import type { VisualResultItem, VisualResultsPayload } from "./visual-results";

// In-memory persistent session memory for SHIKARI's tasks and context
const sessionMemory = new Map<string, { value: string; updatedAt: string }>();

// Pre-seed some default context
sessionMemory.set("assistant_mode", {
  value: "JARVIS-grade engineering partner",
  updatedAt: new Date().toISOString(),
});

export interface MediaIdentificationResult {
  title: string;
  type: string;
  year?: string;
  directorOrArtist?: string;
  synopsis: string;
  imageUrl?: string;
  url?: string;
  visualPayload?: VisualResultsPayload;
}

export async function identifyMedia(
  query: string,
  mediaType: "movie" | "tv_show" | "song" | "video" | "unknown" = "unknown",
): Promise<MediaIdentificationResult> {
  const searchQuery = query.trim();
  const searchTerms =
    mediaType !== "unknown" && !searchQuery.toLowerCase().includes(mediaType)
      ? `${searchQuery} ${mediaType}`
      : searchQuery;

  try {
    // 1. Query Wikipedia Search API for rich media metadata and thumbnail
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      searchTerms,
    )}&gsrlimit=3&prop=extracts|pageimages&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=600&format=json`;

    const res = await fetch(wikiUrl, {
      headers: {
        "User-Agent": "SophiaJARVIS/2.0 (voice-assistant; contact@examglow.com)",
      },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title: string;
              extract?: string;
              thumbnail?: { source: string };
            }
          >;
        };
      };

      const pages = Object.values(data.query?.pages || {}).sort(
        (a, b) => (a.index ?? 99) - (b.index ?? 99),
      );
      if (pages.length > 0 && pages[0]?.title) {
        const top = pages[0];
        const title = top.title;
        const synopsis = (top.extract || "").slice(0, 500);
        const imageUrl = top.thumbnail?.source;
        const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;

        // Extract year if present in title or synopsis
        const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(title) || /\b(19\d{2}|20\d{2})\b/.exec(synopsis);
        const year = yearMatch ? yearMatch[1] : undefined;

        // Auto-save to active task memory
        sessionMemory.set("active_media", {
          value: `${title}${year ? ` (${year})` : ""}: ${synopsis.slice(0, 160)}`,
          updatedAt: new Date().toISOString(),
        });

        const visualItem: VisualResultItem = {
          id: `media-${Date.now()}`,
          kind: "link",
          title,
          subtitle: `${year ? `${year} • ` : ""}${synopsis.slice(0, 180)}...`,
          url: pageUrl,
          imageUrl,
          domain: "wikipedia.org",
        };

        const visualPayload: VisualResultsPayload = {
          heading: `Identified: ${title}`,
          queryLabel: mediaType !== "unknown" ? `Media • ${mediaType}` : "Media Recognition",
          items: [visualItem],
        };

        return {
          title,
          type: mediaType,
          year,
          synopsis,
          imageUrl,
          url: pageUrl,
          visualPayload,
        };
      }
    }

    // 2. Fallback to DuckDuckGo Instant Answer
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json&no_html=1`;
    const ddgRes = await fetch(ddgUrl);
    if (ddgRes.ok) {
      const ddgData = (await ddgRes.json()) as {
        Heading?: string;
        AbstractText?: string;
        Image?: string;
        AbstractURL?: string;
      };

      if (ddgData.Heading && ddgData.AbstractText) {
        const title = ddgData.Heading;
        const synopsis = ddgData.AbstractText.slice(0, 500);
        const imageUrl = ddgData.Image ? (ddgData.Image.startsWith("http") ? ddgData.Image : `https://duckduckgo.com${ddgData.Image}`) : undefined;
        const pageUrl = ddgData.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(title)}`;

        sessionMemory.set("active_media", {
          value: `${title}: ${synopsis.slice(0, 160)}`,
          updatedAt: new Date().toISOString(),
        });

        const visualItem: VisualResultItem = {
          id: `media-${Date.now()}`,
          kind: "link",
          title,
          subtitle: synopsis.slice(0, 180),
          url: pageUrl,
          imageUrl,
          domain: "duckduckgo.com",
        };

        return {
          title,
          type: mediaType,
          synopsis,
          imageUrl,
          url: pageUrl,
          visualPayload: {
            heading: `Identified: ${title}`,
            queryLabel: "Media Recognition",
            items: [visualItem],
          },
        };
      }
    }
  } catch (err) {
    console.error("[identifyMedia] Error:", err);
  }

  return {
    title: query,
    type: mediaType,
    synopsis: `No exact database match found for "${query}", but the title was noted in SHIKARI's memory.`,
  };
}

export async function liveWebSearch(query: string): Promise<{
  results: Array<{ title: string; snippet: string; url: string }>;
  visualPayload?: VisualResultsPayload;
}> {
  const q = query.trim();
  const results: Array<{ title: string; snippet: string; url: string }> = [];

  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      q,
    )}&gsrlimit=3&prop=extracts|pageimages&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=400&format=json`;

    const res = await fetch(wikiUrl, {
      headers: { "User-Agent": "SophiaJARVIS/2.0" },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title: string;
              extract?: string;
              thumbnail?: { source: string };
            }
          >;
        };
      };

      const pages = Object.values(data.query?.pages || {}).sort(
        (a, b) => (a.index ?? 99) - (b.index ?? 99),
      );
      const visualItems: VisualResultItem[] = [];

      for (const p of pages) {
        if (!p.title) continue;
        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/\s+/g, "_"))}`;
        const snippet = (p.extract || "").slice(0, 300);
        results.push({ title: p.title, snippet, url });

        visualItems.push({
          id: `search-${Date.now()}-${visualItems.length}`,
          kind: "link",
          title: p.title,
          subtitle: snippet.slice(0, 140),
          url,
          imageUrl: p.thumbnail?.source,
          domain: "wikipedia.org",
        });
      }

      if (visualItems.length > 0) {
        return {
          results,
          visualPayload: {
            heading: `Web Results for "${q}"`,
            queryLabel: "Live Web Intelligence",
            items: visualItems,
          },
        };
      }
    }
  } catch (err) {
    console.error("[liveWebSearch] Error:", err);
  }

  return { results };
}

export function manageSessionMemory(
  action: "get" | "set" | "list",
  key?: string,
  value?: string,
): { status: string; memory: Record<string, string> } {
  const normKey = (key || "active_task").toLowerCase().trim();

  if (action === "set" && value) {
    sessionMemory.set(normKey, { value: value.trim(), updatedAt: new Date().toISOString() });
    return {
      status: `Stored "${normKey}" successfully`,
      memory: Object.fromEntries(Array.from(sessionMemory.entries()).map(([k, v]) => [k, v.value])),
    };
  }

  if (action === "get" && key) {
    const item = sessionMemory.get(normKey);
    return {
      status: item ? "Found" : "Key not found",
      memory: item ? { [normKey]: item.value } : {},
    };
  }

  return {
    status: "All session memory",
    memory: Object.fromEntries(Array.from(sessionMemory.entries()).map(([k, v]) => [k, v.value])),
  };
}

export function executeCodeCalculation(expression: string): {
  result: unknown;
  type: string;
  error?: string;
} {
  try {
    const sandbox = {
      Math,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      parseInt,
      parseFloat,
      Buffer,
    };
    const script = new vm.Script(`(() => { return (${expression}); })()`);
    const context = vm.createContext(sandbox);
    const result = script.runInContext(context, { timeout: 1200 });

    return {
      result,
      type: typeof result,
    };
  } catch (err) {
    return {
      result: null,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function generateJarvisStatusBriefing(location?: UserLocation): {
  briefing: Record<string, unknown>;
  visualPayload: VisualResultsPayload;
} {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const memoryEntries = Array.from(sessionMemory.entries()).map(([k, v]) => `${k}: ${v.value}`);

  const briefing = {
    status: "All Systems Operational",
    time: timeStr,
    date: dateStr,
    partner: "SHIKARI",
    location: location
      ? {
          city: location.city || "Unknown City",
          coords: `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`,
        }
      : "GPS Standby",
    activeMemoryItems: sessionMemory.size,
    recentMemory: memoryEntries.slice(-3),
  };

  const visualPayload: VisualResultsPayload = {
    heading: "JARVIS HUD System Status",
    queryLabel: `${timeStr} • Systems Nominal`,
    items: [
      {
        id: `hud-${Date.now()}`,
        kind: "code",
        title: "Systems Diagnostic & Context",
        language: "json",
        code: JSON.stringify(briefing, null, 2),
      },
    ],
  };

  return { briefing, visualPayload };
}
