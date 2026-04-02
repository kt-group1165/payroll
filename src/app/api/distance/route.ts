import { createClient } from "@supabase/supabase-js";

type Pair = { origin: string; destination: string };
type DistResult = Pair & { distance_meters: number; duration_seconds: number };

export async function POST(request: Request) {
  try {
  const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const { pairs }: { pairs: Pair[] } = await request.json();
  if (!pairs || pairs.length === 0) return Response.json({ results: [] });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const results: DistResult[] = [];
  const uncached: Pair[] = [];

  // キャッシュ確認（バッチ取得）
  const uniquePairs = pairs.filter(
    (p, i, arr) => arr.findIndex((x) => x.origin === p.origin && x.destination === p.destination) === i
  );

  for (const pair of uniquePairs) {
    const { data } = await supabase
      .from("distance_cache")
      .select("distance_meters,duration_seconds")
      .eq("origin_address", pair.origin)
      .eq("destination_address", pair.destination)
      .single();

    if (data) {
      results.push({ ...pair, distance_meters: data.distance_meters, duration_seconds: data.duration_seconds });
    } else {
      uncached.push(pair);
    }
  }

  // 未キャッシュ分をGoogle APIで取得（origin単位でバッチ）
  let firstGoogleStatus = "";
  if (uncached.length > 0 && GOOGLE_API_KEY) {
    const byOrigin = new Map<string, string[]>();
    for (const pair of uncached) {
      if (!byOrigin.has(pair.origin)) byOrigin.set(pair.origin, []);
      byOrigin.get(pair.origin)!.push(pair.destination);
    }

    for (const [origin, destinations] of byOrigin) {
      for (let i = 0; i < destinations.length; i += 25) {
        const chunk = destinations.slice(i, i + 25);
        const url =
          `https://maps.googleapis.com/maps/api/distancematrix/json` +
          `?origins=${encodeURIComponent(origin)}` +
          `&destinations=${chunk.map(encodeURIComponent).join("|")}` +
          `&mode=driving&language=ja&key=${GOOGLE_API_KEY}`;

        const res = await fetch(url);
        const data = await res.json();

        if (!firstGoogleStatus) firstGoogleStatus = `${data.status} / msg: ${data.error_message ?? "none"}`;
        if (data.status !== "OK") continue;
        const row = data.rows[0];
        if (!row) continue;

        const cacheRows: { origin_address: string; destination_address: string; distance_meters: number; duration_seconds: number }[] = [];

        for (let j = 0; j < chunk.length; j++) {
          const elem = row.elements[j];
          if (elem?.status !== "OK") continue;
          const r: DistResult = {
            origin,
            destination: chunk[j],
            distance_meters: elem.distance.value,
            duration_seconds: elem.duration.value,
          };
          results.push(r);
          cacheRows.push({
            origin_address: origin,
            destination_address: chunk[j],
            distance_meters: elem.distance.value,
            duration_seconds: elem.duration.value,
          });
        }

        if (cacheRows.length > 0) {
          await supabase
            .from("distance_cache")
            .upsert(cacheRows, { onConflict: "origin_address,destination_address" });
        }
      }
    }
  }

  // デバッグ情報
  const debugSample = results.slice(0, 2).map((r) => ({
    origin: r.origin.slice(0, 50),
    destination: r.destination.slice(0, 50),
    dist: r.distance_meters,
  }));
  return Response.json({ results, _debug: { pairsSent: uniquePairs.length, uncachedCount: uncached.length, resultsCount: results.length, apiKeySet: !!GOOGLE_API_KEY, apiKeyLen: GOOGLE_API_KEY.length, googleStatus: firstGoogleStatus, sample: debugSample } });
  } catch (e) {
    console.error("[distance API]", e);
    return Response.json({ error: String(e), results: [] }, { status: 500 });
  }
}
