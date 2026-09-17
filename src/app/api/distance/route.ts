import { createClient } from "@/lib/supabase/server";
import { allowedChunkCount, getMonthlyLimit, getMonthlyUsed, usageMonthJst } from "@/lib/distance-usage";

type Pair = { origin: string; destination: string };
type DistResult = Pair & { distance_meters: number; duration_seconds: number };

export async function POST(request: Request) {
  try {
  const GOOGLE_API_KEY = (process.env["DISTANCE_API_KEY"] ?? process.env["GOOGLE_MAPS_API_KEY"] ?? "") as string;
  const { pairs, office_number, source: rawSource }: { pairs: Pair[]; office_number?: string; source?: string } = await request.json();
  const officeNumber = typeof office_number === "string" && office_number ? office_number : null;
  const source = typeof rawSource === "string" && rawSource ? rawSource : null;
  if (!pairs || pairs.length === 0) return Response.json({ results: [] });

  // Phase 3-3a: 共通 Supabase の payroll_distance_cache は anon DROP 後 authenticated 必須。
  // request cookie から session を読み込んで RLS 上 authenticated として動く。
  const supabase = await createClient();
  const results: DistResult[] = [];
  const uncached: Pair[] = [];

  // キャッシュ確認（originでまとめて取得してJSでマッチ）
  const uniquePairs = pairs.filter(
    (p, i, arr) => arr.findIndex((x) => x.origin === p.origin && x.destination === p.destination) === i
  );
  const uniqueOrigins = [...new Set(uniquePairs.map((p) => p.origin))];
  // payroll_distance_cache は origin × destination のクロス積で蓄積されるため、
  // 同一 origin に対して 1000 件超のキャッシュが残る可能性あり。PostgREST 上限回避のため paginate。
  type CacheRow = { origin_address: string; destination_address: string; distance_meters: number; duration_seconds: number };
  const cachedRows: CacheRow[] = [];
  {
    const PAGE = 1000;
    let cFrom = 0;
    while (true) {
      const { data } = await supabase
        .from("payroll_distance_cache")
        .select("origin_address,destination_address,distance_meters,duration_seconds")
        .in("origin_address", uniqueOrigins)
        .order("id").range(cFrom, cFrom + PAGE - 1);
      if (!data || data.length === 0) break;
      cachedRows.push(...(data as CacheRow[]));
      if (data.length < PAGE) break;
      cFrom += PAGE;
    }
  }
  const cacheMap = new Map<string, { distance_meters: number; duration_seconds: number }>(
    cachedRows.map((r) => [
      `${r.origin_address}|||${r.destination_address}`,
      { distance_meters: r.distance_meters, duration_seconds: r.duration_seconds },
    ])
  );

  for (const pair of uniquePairs) {
    const cached = cacheMap.get(`${pair.origin}|||${pair.destination}`);
    if (cached) {
      results.push({ ...pair, ...cached });
    } else {
      uncached.push(pair);
    }
  }

  // 未キャッシュ分をGoogle APIで取得（origin単位でバッチ）
  // 2026-09-17: 月間上限 (lib/distance-usage.ts) を超える呼出はしない。
  //   Google 側の割り当ては日/分単位しか無く、予算アラートは止めないため。
  //   呼んだ件数は payroll_distance_api_usage に記録する。記録できないときは呼ばない (上限が効かなくなるため)。
  let firstGoogleStatus = "";
  const googleErrors: string[] = [];
  let limitReached = false;
  let skippedPairs = 0;
  const usageMonth = usageMonthJst();
  let usage: { month: string; used: number; limit: number } | null = null;
  if (uncached.length > 0 && !GOOGLE_API_KEY) {
    googleErrors.push("Google APIキーが設定されていません");
  }
  if (uncached.length > 0 && GOOGLE_API_KEY) {
    const byOrigin = new Map<string, string[]>();
    for (const pair of uncached) {
      if (!byOrigin.has(pair.origin)) byOrigin.set(pair.origin, []);
      byOrigin.get(pair.origin)!.push(pair.destination);
    }
    const chunks: { origin: string; destinations: string[] }[] = [];
    for (const [origin, destinations] of byOrigin) {
      for (let i = 0; i < destinations.length; i += 25) chunks.push({ origin, destinations: destinations.slice(i, i + 25) });
    }

    const [{ limit, error: limitErr }, { used, error: usedErr }] = await Promise.all([
      getMonthlyLimit(supabase),
      getMonthlyUsed(supabase, usageMonth),
    ]);
    if (limitErr || usedErr) {
      console.error("[distance API] 利用件数の取得に失敗したため Google を呼びません:", limitErr ?? usedErr);
      return Response.json(
        { error: `Google API の利用件数を確認できませんでした (${limitErr ?? usedErr})`, results },
        { status: 500 },
      );
    }
    let usedNow = used;
    const allowed = allowedChunkCount(chunks.map((c) => c.destinations.length), used, limit);
    if (allowed < chunks.length) {
      limitReached = true;
      skippedPairs = chunks.slice(allowed).reduce((s, c) => s + c.destinations.length, 0);
    }

    for (const { origin, destinations: chunk } of chunks.slice(0, allowed)) {
        const url =
          `https://maps.googleapis.com/maps/api/distancematrix/json` +
          `?origins=${encodeURIComponent(origin)}` +
          `&destinations=${chunk.map(encodeURIComponent).join("|")}` +
          `&mode=driving&language=ja&key=${GOOGLE_API_KEY}`;

        const res = await fetch(url);
        const data = await res.json();

        if (!firstGoogleStatus) firstGoogleStatus = `${data.status} / msg: ${data.error_message ?? "none"}`;
        const billed = data.status === "OK" ? chunk.length : 0;
        const { error: usageErr } = await supabase.from("payroll_distance_api_usage").insert({
          usage_month: usageMonth,
          elements: billed,
          google_status: String(data.status ?? "UNKNOWN"),
          office_number: officeNumber,
          source,
        });
        usedNow += billed;
        if (usageErr) {
          // 記録できない = 上限が効かない。これ以上は呼ばない
          console.error("[distance API] 利用件数の記録に失敗:", usageErr.message);
          googleErrors.push(`利用件数の記録に失敗したため途中で止めました (${usageErr.message})`);
          break;
        }
        if (data.status !== "OK") {
          googleErrors.push(`${data.status}${data.error_message ? `: ${data.error_message}` : ""}`);
          continue;
        }
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
          const { error: cacheErr } = await supabase
            .from("payroll_distance_cache")
            .upsert(cacheRows, { onConflict: "origin_address,destination_address" });
          if (cacheErr) console.error("[distance API] キャッシュ保存失敗:", cacheErr.message);
        }
    }
    usage = { month: usageMonth, used: usedNow, limit };
  }

  // デバッグ情報
  const debugSample = results.slice(0, 2).map((r) => ({
    origin: r.origin.slice(0, 50),
    destination: r.destination.slice(0, 50),
    dist: r.distance_meters,
  }));
  return Response.json({ results, limitReached, skippedPairs, googleErrors: [...new Set(googleErrors)], usage, _debug: { pairsSent: uniquePairs.length, uncachedCount: uncached.length, resultsCount: results.length, apiKeySet: !!GOOGLE_API_KEY, apiKeyLen: GOOGLE_API_KEY.length, googleStatus: firstGoogleStatus, sample: debugSample } });
  } catch (e) {
    console.error("[distance API]", e);
    return Response.json({ error: String(e), results: [] }, { status: 500 });
  }
}
