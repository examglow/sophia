import {
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  ExternalLink,
  Footprints,
  Globe,
  MapPin,
  Navigation,
  Play,
  Route,
  X,
} from "lucide-react";
import { useState } from "react";

import type { VisualResultItem, VisualResultsPayload } from "@/lib/visual-results";

type VisualResultsDeckProps = {
  payload: VisualResultsPayload;
  onDismiss: () => void;
};

function MediaPreview({ item, featured }: { item: VisualResultItem; featured: boolean }) {
  const sources = [
    item.imageUrl,
    item.url && /^https?:\/\//.test(item.url)
      ? `https://image.thum.io/get/width/1200/crop/760/noanimate/${item.url}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];
  const showImage = Boolean(src);

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl sophia-thumb-fallback ${
        featured ? "aspect-[16/9]" : "aspect-[16/10]"
      }`}
    >
      {showImage ? (
        <img
          key={src}
          src={src}
          alt={item.title}
          loading="lazy"
          onError={() => setAttempt((n) => n + 1)}
          className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"
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
    <article className="sophia-visual-card flex flex-col gap-3 rounded-2xl p-4">
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

function MapCard({ item }: { item: VisualResultItem }) {
  const [showSteps, setShowSteps] = useState(false);
  const embedUrl =
    item.embedUrl ||
    (item.destination
      ? `https://maps.google.com/maps?q=${encodeURIComponent(item.destination)}&t=&z=14&ie=UTF8&iwloc=&output=embed`
      : undefined);

  return (
    <article className="sophia-visual-card flex flex-col gap-3.5 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-primary">
              <Navigation className="h-4 w-4" />
            </span>
            <h3 className="truncate text-base font-semibold text-foreground">{item.title}</h3>
          </div>
          {item.destination && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="truncate">{item.destination}</span>
            </p>
          )}
        </div>

        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-transform hover:scale-105"
          >
            <Navigation className="h-3.5 w-3.5 fill-current" />
            Google Maps
          </a>
        )}
      </div>

      {(item.duration || item.distance || item.mode) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {item.duration && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/85 px-3 py-1 font-medium text-foreground">
              <Clock className="h-3.5 w-3.5 text-primary" />
              {item.duration}
            </span>
          )}
          {item.distance && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/85 px-3 py-1 font-medium text-muted-foreground">
              <Route className="h-3.5 w-3.5 text-primary" />
              {item.distance}
            </span>
          )}
          {item.mode && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/85 px-3 py-1 font-medium capitalize text-muted-foreground">
              {item.mode === "walking" ? (
                <Footprints className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Car className="h-3.5 w-3.5 text-primary" />
              )}
              {item.mode}
            </span>
          )}
          {item.origin && (
            <span className="truncate max-w-[220px] text-[11px] text-muted-foreground/80">
              From {item.origin}
            </span>
          )}
        </div>
      )}

      {embedUrl && (
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-border/60 bg-muted/20">
          <iframe
            title={item.title}
            src={embedUrl}
            loading="lazy"
            className="h-full w-full border-0"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      )}

      {item.steps && item.steps.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2">
          <button
            type="button"
            onClick={() => setShowSteps((s) => !s)}
            className="flex items-center justify-between py-1 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <span>Turn-by-turn steps ({item.steps.length})</span>
            {showSteps ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {showSteps && (
            <ol className="flex flex-col gap-2 pl-1 pt-1 text-xs leading-relaxed text-foreground/90">
              {item.steps.map((step, idx) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    {idx + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}

function LinkOrVideoCard({ item, featured }: { item: VisualResultItem; featured: boolean }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`sophia-visual-card group flex flex-col gap-2.5 rounded-2xl transition-all duration-300 hover:border-primary/40 hover:bg-card/85 ${
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
        ) : featured.kind === "map" ? (
          <MapCard item={featured} />
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
            ) : item.kind === "map" ? (
              <div key={item.id} className="col-span-2">
                <MapCard item={item} />
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
