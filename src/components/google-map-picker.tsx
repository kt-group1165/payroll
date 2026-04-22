"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  /** 初期緯度（null のときは日本の中心付近にフォールバック） */
  latitude: number | null;
  /** 初期経度 */
  longitude: number | null;
  /** ジオコーディング用の住所（緯度経度未設定時に地図の初期位置に使う） */
  fallbackAddress?: string;
  /** ピンが動いたときに呼ばれる */
  onChange: (lat: number, lng: number) => void;
  /** 地図の高さ（CSS） */
  height?: string;
};

// Google Maps JS API を一度だけロード
let mapsLoadPromise: Promise<void> | null = null;
function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("window is undefined"));
  const w = window as unknown as { google?: { maps?: unknown } };
  if (w.google?.maps) return Promise.resolve();
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-google-maps]");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Google Maps load error")));
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&language=ja&region=JP`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Maps load error"));
    document.head.appendChild(script);
  });
  return mapsLoadPromise;
}

// 最小限の型宣言（Maps JS API）
type LatLngLiteral = { lat: number; lng: number };
interface MarkerLike {
  setPosition: (p: LatLngLiteral) => void;
  addListener: (ev: string, cb: () => void) => void;
  getPosition: () => { lat: () => number; lng: () => number };
}
interface MapLike {
  setCenter: (p: LatLngLiteral) => void;
  panTo: (p: LatLngLiteral) => void;
}
interface GeocoderResult {
  geometry: { location: { lat: () => number; lng: () => number } };
}
interface GeocoderLike {
  geocode: (
    req: { address: string },
    cb: (results: GeocoderResult[] | null, status: string) => void,
  ) => void;
}

export function GoogleMapPicker({ latitude, longitude, fallbackAddress, onChange, height = "300px" }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLike | null>(null);
  const markerRef = useRef<MarkerLike | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

  useEffect(() => {
    if (!apiKey) {
      setStatus("error");
      setMessage("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY が設定されていません");
      return;
    }
    setStatus("loading");
    loadGoogleMaps(apiKey)
      .then(() => setStatus("ready"))
      .catch((e) => {
        setStatus("error");
        setMessage(String(e));
      });
  }, [apiKey]);

  useEffect(() => {
    if (status !== "ready" || !mapDivRef.current) return;
    const g = (window as unknown as { google: { maps: Record<string, unknown> } }).google.maps;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gm = g as any;

    const hasCoords = typeof latitude === "number" && typeof longitude === "number";
    const initial: LatLngLiteral = hasCoords
      ? { lat: latitude as number, lng: longitude as number }
      : { lat: 35.681236, lng: 139.767125 }; // 東京駅（フォールバック）

    const map = new gm.Map(mapDivRef.current, {
      center: initial,
      zoom: hasCoords ? 16 : 12,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true,
    });
    const marker = new gm.Marker({
      position: initial,
      map,
      draggable: true,
    });

    marker.addListener("dragend", () => {
      const pos = marker.getPosition();
      onChange(pos.lat(), pos.lng());
    });

    map.addListener("click", (e: { latLng: { lat: () => number; lng: () => number } }) => {
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();
      marker.setPosition({ lat, lng });
      onChange(lat, lng);
    });

    mapRef.current = map;
    markerRef.current = marker;

    // 座標未設定かつ住所がある場合はジオコーディングで初期位置を設定
    if (!hasCoords && fallbackAddress) {
      const geocoder: GeocoderLike = new gm.Geocoder();
      geocoder.geocode({ address: fallbackAddress }, (results, geoStatus) => {
        if (geoStatus === "OK" && results && results.length > 0) {
          const loc = results[0].geometry.location;
          const pos = { lat: loc.lat(), lng: loc.lng() };
          map.panTo(pos);
          marker.setPosition(pos);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // 外部から latitude/longitude が変わった場合はマーカーを移動
  useEffect(() => {
    if (status !== "ready" || !markerRef.current || !mapRef.current) return;
    if (typeof latitude === "number" && typeof longitude === "number") {
      markerRef.current.setPosition({ lat: latitude, lng: longitude });
      mapRef.current.panTo({ lat: latitude, lng: longitude });
    }
  }, [latitude, longitude, status]);

  if (status === "error") {
    return (
      <div className="text-sm text-red-600 border border-red-200 bg-red-50 rounded p-3">
        マップを読み込めません: {message}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div ref={mapDivRef} style={{ height, width: "100%" }} className="rounded-md border bg-muted" />
      <p className="text-xs text-muted-foreground">
        地図をクリックまたはピンをドラッグして位置を指定してください。
      </p>
    </div>
  );
}
