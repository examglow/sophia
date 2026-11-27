export type UserLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  city?: string;
  label?: string;
};

export type RouteStep = {
  instruction: string;
  distance: string;
  duration?: string;
};

export type RouteDetails = {
  origin: string;
  destination: string;
  distance: string;
  duration: string;
  mode: "driving" | "walking" | "bicycling";
  steps: RouteStep[];
  googleMapsUrl: string;
  embedUrl: string;
  destCoords?: { lat: number; lon: number };
};

// Calculate straight-line distance in miles
export function haversineDistanceMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 3958.8; // Radius of Earth in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function formatDistanceMiles(metersOrMiles: number, isMeters = false): string {
  const miles = isMeters ? metersOrMiles * 0.000621371 : metersOrMiles;
  if (miles < 0.1) {
    const feet = Math.round(miles * 5280);
    return `${feet} ft`;
  }
  return `${miles.toFixed(1)} mi`;
}

export function formatDurationSeconds(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${mins} mins`;
  const hrs = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins > 0 ? `${hrs} hr ${remainingMins} min` : `${hrs} hr`;
}

export function buildGoogleMapsDirUrl(
  origin: { lat: number; lon: number },
  destination: string,
  mode: "driving" | "walking" | "bicycling" = "driving",
): string {
  const travelMode = mode === "walking" ? "walking" : mode === "bicycling" ? "bicycling" : "driving";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${encodeURIComponent(
    destination,
  )}&travelmode=${travelMode}`;
}

export function buildGoogleMapsEmbedUrl(destination: string): string {
  return `https://maps.google.com/maps?q=${encodeURIComponent(destination)}&t=&z=14&ie=UTF8&iwloc=&output=embed`;
}

export async function reverseGeocode(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<{ city: string; label: string } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      {
        headers: { "User-Agent": "SophiaVoiceAssistant/1.0" },
        signal: signal ? AbortSignal.timeout(3500) : undefined,
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      display_name?: string;
      address?: {
        city?: string;
        town?: string;
        village?: string;
        suburb?: string;
        state?: string;
        country?: string;
        road?: string;
      };
    };
    const addr = data.address ?? {};
    const city = addr.city || addr.town || addr.village || addr.suburb || addr.state || "";
    const label = data.display_name?.split(",").slice(0, 3).join(",").trim() || city;
    return { city, label };
  } catch {
    return null;
  }
}

export async function geocodePlace(
  query: string,
  near?: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<{ name: string; displayName: string; lat: number; lon: number } | null> {
  try {
    let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    if (near) {
      const delta = 0.5; // ~30 miles bounding box
      url += `&viewbox=${near.lon - delta},${near.lat + delta},${near.lon + delta},${near.lat - delta}`;
    }
    const res = await fetch(url, {
      headers: { "User-Agent": "SophiaVoiceAssistant/1.0" },
      signal: signal ? AbortSignal.timeout(4000) : undefined,
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{
      name?: string;
      display_name?: string;
      lat?: string;
      lon?: string;
    }>;
    if (!list || list.length === 0) return null;
    const item = list[0];
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    return {
      name: item.name || query,
      displayName: item.display_name || query,
      lat,
      lon,
    };
  } catch {
    return null;
  }
}

export async function fetchRouteFromOsrm(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<{ distanceMeters: number; durationSeconds: number; steps: RouteStep[] } | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=false&steps=true`;
    const res = await fetch(url, {
      signal: signal ? AbortSignal.timeout(4000) : undefined,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        legs?: Array<{
          steps?: Array<{
            name?: string;
            maneuver?: { type?: string; modifier?: string };
            distance?: number;
            duration?: number;
          }>;
        }>;
      }>;
    };
    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) return null;
    const route = data.routes[0];
    const rawSteps = route.legs?.[0]?.steps ?? [];
    const steps: RouteStep[] = [];

    for (const step of rawSteps) {
      const type = step.maneuver?.type;
      const modifier = step.maneuver?.modifier;
      const road = step.name ? ` onto ${step.name}` : "";
      const distStr = step.distance ? ` (${formatDistanceMiles(step.distance, true)})` : "";

      let text = "";
      if (type === "depart") {
        text = `Depart${road}${distStr}`;
      } else if (type === "arrive") {
        text = `Arrive at destination`;
      } else if (type === "turn") {
        text = `Turn ${modifier || "ahead"}${road}${distStr}`;
      } else if (type === "new name") {
        text = `Continue${road}${distStr}`;
      } else {
        const action = type || "Head";
        const dir = modifier ? ` ${modifier}` : "";
        text = `${action}${dir}${road}${distStr}`;
      }

      if (text) {
        steps.push({
          instruction: text,
          distance: formatDistanceMiles(step.distance ?? 0, true),
          duration: formatDurationSeconds(step.duration ?? 0),
        });
      }
    }

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      steps: steps.slice(0, 10),
    };
  } catch {
    return null;
  }
}

export async function getDirections(params: {
  origin?: { lat: number; lon: number; label?: string };
  destinationQuery: string;
  mode?: "driving" | "walking" | "bicycling";
  signal?: AbortSignal;
}): Promise<RouteDetails> {
  const { origin, destinationQuery, signal } = params;
  const mode = params.mode || "driving";

  // Geocode destination
  const geoDest = await geocodePlace(
    destinationQuery,
    origin ? { lat: origin.lat, lon: origin.lon } : undefined,
    signal,
  );

  const destTitle = geoDest?.name || destinationQuery;
  const originStr = origin ? origin.label || `${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}` : "Current Location";

  let distanceStr = "A few miles away";
  let durationStr = "A few minutes";
  const steps: RouteStep[] = [];

  if (origin && geoDest) {
    const osrm = await fetchRouteFromOsrm(
      { lat: origin.lat, lon: origin.lon },
      { lat: geoDest.lat, lon: geoDest.lon },
      signal,
    );

    if (osrm) {
      // Adjust duration if walking or bicycling
      let durationSec = osrm.durationSeconds;
      if (mode === "walking") {
        // Average walking speed ~3 mph (1.34 m/s)
        durationSec = Math.round(osrm.distanceMeters / 1.34);
      } else if (mode === "bicycling") {
        // Average biking speed ~12 mph (5.36 m/s)
        durationSec = Math.round(osrm.distanceMeters / 5.36);
      }

      distanceStr = formatDistanceMiles(osrm.distanceMeters, true);
      durationStr = formatDurationSeconds(durationSec);
      if (osrm.steps.length > 0) {
        steps.push(...osrm.steps);
      }
    } else {
      // Fallback straight line
      const miles = haversineDistanceMiles(origin.lat, origin.lon, geoDest.lat, geoDest.lon);
      distanceStr = formatDistanceMiles(miles);
      const speedMph = mode === "walking" ? 3 : mode === "bicycling" ? 12 : 30;
      durationStr = formatDurationSeconds((miles / speedMph) * 3600);
      steps.push({
        instruction: `Head toward ${destTitle}`,
        distance: distanceStr,
      });
    }
  }

  const googleMapsUrl = origin
    ? buildGoogleMapsDirUrl({ lat: origin.lat, lon: origin.lon }, destTitle, mode)
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destTitle)}`;

  const embedUrl = buildGoogleMapsEmbedUrl(destTitle);

  return {
    origin: originStr,
    destination: destTitle,
    distance: distanceStr,
    duration: durationStr,
    mode,
    steps,
    googleMapsUrl,
    embedUrl,
    destCoords: geoDest ? { lat: geoDest.lat, lon: geoDest.lon } : undefined,
  };
}
