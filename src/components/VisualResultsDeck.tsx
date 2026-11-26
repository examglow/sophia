import { Check, Copy, ExternalLink, Globe, Play, X } from "lucide-react";
import { useState } from "react";

import type { VisualResultItem, VisualResultsPayload } from "@/lib/visual-results";

type VisualResultsDeckProps = {
  payload: VisualResultsPayload;
  onDismiss: () => void;
};

function MediaPreview({ item, featured }: { item: VisualResultItem; featured: boolean }) {
  const [broken, setBroken] = useState(false);
  const showImage = Boolean(item.imageUrl) && !broken;

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl aether-thumb-fallback ${
        featured ? "aspect-[16/9]" : "aspect-[16/10]"
      }`}
    >
      {showImage ? (
        <img
          src={item.imageUrl}
          alt={item.title}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Globe className="h-6 w-6 text-primary/80" />
          {item.domain && (
            <span className="truncate max-w-full text-xs font-medium tracking-wide text-foreground/85">
              {item.domain}
            </span>
          )}
        </div>
      )}
      {item.kind === "video" && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center bg-background/15"
        >
          <span
            className={`flex items-center justify-center rounded-full border border-foreground/20 bg-background/55 text-foreground backdrop-blur-md transition-transform duration-300 group-hover:scale-110 ${
              featured ? "h-14 w-14" : "h-10 w-10"
            }`}
          >
            <Play className={`${featured ? "h-6 w-6" : "h-4 w-4"} translate-x-0.5 fill-current`} />
          </span>
        </span>
      )}
    </div>
  );
}

function CodeCard({ item }: { item: VisualResultItem }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!item.code) return;
    void navigator.clipboard?.writeText(item.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <article className="aether-visual-card flex flex-col gap-3 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{item.title}</h3>
          {item.language && (
            <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
              {item.language}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/70 px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent cursor-pointer"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-60 overflow-auto rounded-xl bg-background/70 p-3 font-mono text-xs leading-relaxed text-foreground/90">
        <code>{item.code}</code>
      </pre>
    </article>
  );
}

function LinkOrVideoCard({ item, featured }: { item: VisualResultItem; featured: boolean }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`aether-visual-card group flex flex-col gap-2.5 rounded-2xl transition-all duration-300 hover:border-primary/40 hover:bg-card/85 ${
        featured ? "p-3.5 sm:p-4" : "p-2.5 sm:p-3"
      }`}
    >
      <MediaPreview item={item} featured={featured} />
      <div className="flex flex-col gap-1 px-0.5">
        <div className="flex items-start justify-between gap-2">
          <h3
            className={`font-semibold leading-snug text-foreground ${
              featured ? "text-base sm:text-lg line-clamp-2" : "text-xs sm:text-sm line-clamp-2"
            }`}
          >
            {item.title}
          </h3>
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
        </div>
        {featured && item.subtitle && (
          <p className="line-clamp-2 text-xs sm:text-sm leading-relaxed text-muted-foreground">
            {item.subtitle}
          </p>
        )}
        {item.domain && (
          <span className="text-[11px] font-medium text-muted-foreground/90">{item.domain}</span>
        )}
      </div>
    </a>
  );
}

export function VisualResultsDeck({ payload, onDismiss }: VisualResultsDeckProps) {
  const [featured, ...rest] = payload.items;

  return (
    <section
      aria-label={payload.heading}
      className="flex w-full max-w-xl flex-col gap-3.5 animate-in fade-in slide-in-from-bottom-3 duration-300"
    >
      {payload.queryLabel && (
        <div className="flex justify-end">
          <span className="max-w-[85%] truncate rounded-full border border-border bg-visual-pill px-4 py-1.5 text-xs font-medium text-foreground/90 backdrop-blur-md">
            {payload.queryLabel}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg sm:text-xl font-medium tracking-tight text-foreground">
          {payload.heading}
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide visual results"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {featured &&
        (featured.kind === "code" ? (
          <CodeCard item={featured} />
        ) : (
          <LinkOrVideoCard item={featured} featured />
        ))}

      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {rest.map((item) =>
            item.kind === "code" ? (
              <div key={item.id} className="col-span-2">
                <CodeCard item={item} />
              </div>
            ) : (
              <LinkOrVideoCard key={item.id} item={item} featured={false} />
            ),
          )}
        </div>
      )}
    </section>
  );
}