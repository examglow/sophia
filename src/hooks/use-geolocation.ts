import { useCallback, useEffect, useRef, useState } from "react";

export type GeolocationCoordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  city?: string;
  label?: string;
};

export type GeolocationStatus = "idle" | "requesting" | "granted" | "denied" | "unavailable";

export function useGeolocation() {
  const [coordinates, setCoordinates] = useState<GeolocationCoordinates | null>(null);
  const [status, setStatus] = useState<GeolocationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const lastGeocodedKeyRef = useRef<string | null>(null);

  const fetchCityName = useCallback(async (lat: number, lon: number): Promise<{ city?: string; label?: string }> => {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (lastGeocodedKeyRef.current === key) return {};
    lastGeocodedKeyRef.current = key;

    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`, {
        headers: { "User-Agent": "SophiaVoiceAssistant/1.0" },
      });
      if (!res.ok) return {};
      const data = (await res.json()) as {
        display_name?: string;
        address?: {
          city?: string;
          town?: string;
          village?: string;
          suburb?: string;
          county?: string;
          state?: string;
        };
      };
      const addr = data.address ?? {};
      const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || addr.state || "";
      const label = data.display_name?.split(",").slice(0, 3).join(",").trim() || city;
      return { city, label };
    } catch {
      return {};
    }
  }, []);

  const updatePosition = useCallback(
    async (pos: GeolocationPosition) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const { city, label } = await fetchCityName(latitude, longitude);

      setCoordinates((prev) => ({
        latitude,
        longitude,
        accuracy,
        city: city || prev?.city,
        label: label || prev?.label,
      }));
      setStatus("granted");
      setError(null);
    },
    [fetchCityName],
  );

  const requestLocation = useCallback(() => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setStatus("unavailable");
      setError("Geolocation is not supported by your browser.");
      return;
    }

    setStatus("requesting");
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void updatePosition(pos);
        if (watchIdRef.current === null) {
          watchIdRef.current = navigator.geolocation.watchPosition(
            (updated) => void updatePosition(updated),
            () => {},
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 },
          );
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
          setError("Location permission denied. Click to allow location access.");
        } else {
          setStatus("unavailable");
          setError(err.message || "Could not retrieve location.");
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }, [updatePosition]);

  // Check if permission was already granted previously
  useEffect(() => {
    if (typeof window === "undefined" || !("permissions" in navigator)) return;
    let isMounted = true;

    navigator.permissions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .query({ name: "geolocation" as any })
      .then((perm) => {
        if (!isMounted) return;
        if (perm.state === "granted") {
          requestLocation();
        } else if (perm.state === "denied") {
          setStatus("denied");
        }
        perm.onchange = () => {
          if (!isMounted) return;
          if (perm.state === "granted") requestLocation();
          else if (perm.state === "denied") setStatus("denied");
        };
      })
      .catch(() => {});

    return () => {
      isMounted = false;
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [requestLocation]);

  return {
    coordinates,
    status,
    error,
    requestLocation,
    isGranted: status === "granted" && coordinates !== null,
  };
}
