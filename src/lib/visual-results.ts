export type VisualResultKind = "video" | "link" | "code";

export type VisualResultItem = {
  id: string;
  kind: VisualResultKind;
  title: string;
  subtitle?: string;
  url?: string;
  domain?: string;
  imageUrl?: string;
  code?: string;
  language?: string;
};

export type VisualResultsPayload = {
  heading: string;
  queryLabel?: string;
  items: VisualResultItem[];
};

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      const v = url.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") &&
        parts[1] &&
        /^[A-Za-z0-9_-]{11}$/.test(parts[1])
      ) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}