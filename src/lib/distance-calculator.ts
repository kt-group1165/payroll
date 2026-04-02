/** 移動距離・通勤距離・移動時間の計算ロジック */

export type VisitForRoute = {
  client_number: string;
  client_address: string;
  dispatch_start_time: string; // "HH:MM" or "HH:MM:SS"
  dispatch_end_time: string;
};

export type DayRouteResult = {
  date: string;
  commute_distance_m: number;  // 自宅→A→...→自宅 全区間
  travel_distance_m: number;   // A→B→C（2時間以上空く区間を除く）
  travel_time_sec: number;     // 15分超の移動時間の合計（2時間空除外）
  legs: LegResult[];
};

export type LegResult = {
  from: string;
  to: string;
  distance_m: number;
  duration_sec: number;
  is_home_leg: boolean;
  gap_excluded: boolean;       // 2時間以上空いて除外
};

export type EmployeeMonthResult = {
  employee_id: string;
  employee_name: string;
  commute_distance_m: number;
  travel_distance_m: number;
  travel_time_sec: number;
  days: DayRouteResult[];
};

/** "HH:MM" or "HH:MM:SS" → 分（数値） */
function toMinutes(t: string): number {
  if (!t) return 0;
  const parts = t.split(":");
  return parseInt(parts[0] ?? "0") * 60 + parseInt(parts[1] ?? "0");
}

const GAP_THRESHOLD_MIN = 120;  // 2時間
const TRAVEL_TIME_THRESHOLD_SEC = 15 * 60; // 15分

type DistMap = Map<string, { distance_meters: number; duration_seconds: number }>;

/**
 * 1日分の経路を計算する
 * @param homeAddress 職員の自宅住所
 * @param visits その日の訪問リスト（dispatch_start_time順にソート済み）
 * @param distMap "origin|||destination" → {distance_meters, duration_seconds}
 */
export function calcDayRoute(
  date: string,
  homeAddress: string,
  visits: VisitForRoute[],
  distMap: DistMap
): DayRouteResult | null {
  if (visits.length === 0) return null;

  // dispatch_start_time 順にソート
  const sorted = [...visits].sort((a, b) =>
    a.dispatch_start_time.localeCompare(b.dispatch_start_time)
  );

  // 経路ポイント: 自宅 → 各訪問先 → 自宅
  const points = [homeAddress, ...sorted.map((v) => v.client_address), homeAddress];

  let commute_distance_m = 0;
  let travel_distance_m = 0;
  let travel_time_sec = 0;
  const legs: LegResult[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const key = `${from}|||${to}`;
    const dist = distMap.get(key);
    if (!dist) continue;

    const isHomeLeg = i === 0 || i === points.length - 2;

    // 2時間ギャップチェック（訪問間のみ）
    let gapExcluded = false;
    if (!isHomeLeg) {
      const visitFrom = sorted[i - 1]; // i=1 → sorted[0], i=2 → sorted[1]...
      const visitTo = sorted[i];
      const endMin = toMinutes(visitFrom.dispatch_end_time);
      const startMin = toMinutes(visitTo.dispatch_start_time);
      const gap = startMin - endMin;
      if (gap >= GAP_THRESHOLD_MIN) gapExcluded = true;
    }

    // 通勤距離: 全区間
    commute_distance_m += dist.distance_meters;

    // 移動距離・移動時間: 自宅区間除外 + 2時間空除外
    if (!isHomeLeg && !gapExcluded) {
      travel_distance_m += dist.distance_meters;
      if (dist.duration_seconds > TRAVEL_TIME_THRESHOLD_SEC) {
        travel_time_sec += dist.duration_seconds - TRAVEL_TIME_THRESHOLD_SEC;
      }
    }

    legs.push({
      from,
      to,
      distance_m: dist.distance_meters,
      duration_sec: dist.duration_seconds,
      is_home_leg: isHomeLeg,
      gap_excluded: gapExcluded,
    });
  }

  return { date, commute_distance_m, travel_distance_m, travel_time_sec, legs };
}

/** 全ペアのアドレスセットを収集する（APIへのリクエスト用） */
export function collectAddressPairs(
  homeAddress: string,
  visitsByDay: Map<string, VisitForRoute[]>
): { origin: string; destination: string }[] {
  const seen = new Set<string>();
  const pairs: { origin: string; destination: string }[] = [];

  const addPair = (origin: string, destination: string) => {
    if (!origin || !destination || origin === destination) return;
    const key = `${origin}|||${destination}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ origin, destination });
  };

  for (const visits of visitsByDay.values()) {
    if (visits.length === 0) continue;
    const sorted = [...visits].sort((a, b) =>
      a.dispatch_start_time.localeCompare(b.dispatch_start_time)
    );
    const points = [homeAddress, ...sorted.map((v) => v.client_address), homeAddress];
    for (let i = 0; i < points.length - 1; i++) {
      addPair(points[i], points[i + 1]);
    }
  }

  return pairs;
}

/** m → km（小数1桁） */
export function mToKm(m: number): string {
  return (m / 1000).toFixed(1);
}

/** 秒 → "X時間Y分" */
export function secToHm(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}
