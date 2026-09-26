"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseDurationMinutes } from "@/lib/payroll/payroll-calc";
import { resolveVisitPay, type VisitRateContext } from "@/lib/payroll/visit-pay";
import { getDoukouEngoFlatRates, getJuhoShortVisitRates, getSougouSeikatsuRates } from "@/lib/app-settings";
import { calcDayRoute, type VisitForRoute } from "@/lib/distance-calculator";

/**
 * /service-records サービス記録一覧 (旧システム「実績確認」service_record_list.php 相当)。
 *
 * 【この画面の決まりごと (2026-09-26 user)】
 *   ★ 読むだけ。直すところは無い (旧システムには 削除・変更 の列があるが 作らない)
 *   ★ 月給者も 時給者と同じ金額を出す (「その訪問はいくらぶんか」を見るため。月給者の支給額ではない)
 *   ★ 常勤換算時間・週勤務時間は **項目だけ**。数値は後で
 *
 * 【旧システムの列の意味 — 2026-09-26 に実画面 (佐久間 未希子 2026/7) で確かめた】
 *   勤務時間 = 訪問時間 + 移動時間      … 9 行すべてで一致 (01:00 + 00:17 = 01:17 など)
 *   移動時間 = 前の訪問からその訪問までの移動。その日の 1 件目は空欄 (自宅の区間は入れない)
 *   日付が変わる手前に 小計 (訪問時間・移動時間・勤務時間・金額・残業時間)
 *   利用者のいない行 = 出勤簿の行 (開始・終了・休憩)
 *   ⚠ 出勤簿行の「勤務時間」が何かは **未特定**。拘束 − 休憩 − (訪問+移動) にならない
 *     (07/01 は 11:30 − 0 − 09:18 = 02:12 のはずが 02:52)。当方は推測で埋めず、
 *     出勤簿から出した当方の勤務時間を出す (列の見出しにその旨を書く)。
 */

type Office = { id: string; office_number: string; name: string; short_name: string; office_type: string };
type Emp = { id: string; employee_number: string; name: string; salary_type: string; role_type: string; job_type: string; employment_status: string };
type Rec = {
  id: string; employee_number: string; service_date: string;
  dispatch_start_time: string; dispatch_end_time: string; calc_duration: string;
  service_code: string; service_type: string | null; client_number: string; client_name: string | null;
  office_number: string; time_period: string | null; holiday_type: string | null;
  accompanied_visit: string | null; amount: number | null;
};
type Att = {
  employee_number: string; day: number; break_time: string | null; work_hours: string | null;
  overtime_daily: string | null; overtime_weekly: string | null;
  start_time_1: string | null; end_time_1: string | null; start_time_2: string | null; end_time_2: string | null;
  start_time_3: string | null; end_time_3: string | null; start_time_4: string | null; end_time_4: string | null;
  start_time_5: string | null; end_time_5: string | null;
};

const normEmp = (v: string | number | null | undefined) => String(v ?? "").trim().replace(/^0+/, "");
const hm = (min: number | null) => (min == null ? "" : `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`);
const yen = (v: number | null) => (v == null ? "" : v.toLocaleString());
const t5 = (v: string | null | undefined) => String(v ?? "").slice(0, 5);
/** "2026-07-01" / "2026/07/01" → "07/01" */
const mmdd = (d: string) => { const s = String(d).replace(/\//g, "-"); return `${s.slice(5, 7)}/${s.slice(8, 10)}`; };
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const weekday = (d: string) => { const t = new Date(String(d).replace(/\//g, "-")); return isNaN(t.getTime()) ? "" : WD[t.getDay()]; };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** 出勤簿 1 日の 開始 (最初の出勤) と 終了 (最後の退勤) */
function attSpan(a: Att): { start: string; end: string } {
  const starts = [a.start_time_1, a.start_time_2, a.start_time_3, a.start_time_4, a.start_time_5].map(t5).filter(Boolean);
  const ends = [a.end_time_1, a.end_time_2, a.end_time_3, a.end_time_4, a.end_time_5].map(t5).filter(Boolean);
  return { start: starts[0] ?? "", end: ends.length ? ends[ends.length - 1] : "" };
}

type VisitRow = {
  kind: "visit"; date: string; rec: Rec;
  visitMin: number; travelMin: number | null; workMin: number | null;
  catName: string; hourlyRate: number | null; pay: number | null;
};
type AttRow = { kind: "att"; date: string; start: string; end: string; brk: string; workMin: number | null; overtime: string };
type SubRow = { kind: "sub"; date: string; visitMin: number; travelMin: number | null; workMin: number | null; pay: number; honobono: number; overtime: string };
type Row = VisitRow | AttRow | SubRow;

/**
 * 見出しのセル。⚠ **コンポーネントの外**に置く。
 * レンダー関数の中で定義すると 再レンダーのたびに型が変わり React が毎回 unmount/remount する
 * (eslint の react-hooks/static-components が捕まえる)。
 */
function TH({ children, right, sticky }: { children?: React.ReactNode; right?: boolean; sticky?: boolean }) {
  return (
    <th className={`sticky top-0 z-20 border-b bg-muted px-2 py-1.5 font-medium whitespace-nowrap ${right ? "text-right" : "text-left"} ${sticky ? "left-0 z-30 border-r" : ""}`}>
      {children}
    </th>
  );
}

export default function ServiceRecordsPage() {
  const [offices, setOffices] = useState<Office[]>([]);
  const [officeId, setOfficeId] = useState("");
  const [month, setMonth] = useState(thisMonth());
  const [emps, setEmps] = useState<Emp[]>([]);
  const [empNo, setEmpNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [travelNote, setTravelNote] = useState<string>("");

  // 絞りこみ
  const [fClient, setFClient] = useState("");
  const [fCode, setFCode] = useState("");
  const [subtotalOnly, setSubtotalOnly] = useState(false);
  const [fDoukou, setFDoukou] = useState(false);
  const [fYoruasa, setFYoruasa] = useState(false);
  const [fShinya, setFShinya] = useState(false);
  const [fHoliday, setFHoliday] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("payroll_offices").select(`id,office_number,office_type, ${OFFICE_MASTER_JOIN}`);
      if (error) { toast.error(`事業所の取得に失敗: ${error.message}`); return; }
      const list = (flattenOfficeMaster(data as never) as unknown as Office[])
        .filter((o) => o.office_type === "訪問介護")
        .sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name, "ja"));
      setOffices(list);
      setOfficeId((p) => p || list[0]?.id || "");
    })();
  }, []);

  const office = useMemo(() => offices.find((o) => o.id === officeId), [offices, officeId]);

  useEffect(() => {
    if (!office) return;
    let dead = false;
    (async () => {
      const { data, error } = await supabase.from("payroll_employees")
        .select("id,employee_number,name,salary_type,role_type,job_type,employment_status")
        .eq("office_id", office.id).order("employee_number");
      if (dead) return;
      if (error) { toast.error(`職員の取得に失敗: ${error.message}`); return; }
      const list = ((data ?? []) as Emp[]).sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setEmps(list);
      setEmpNo((p) => (list.some((e) => normEmp(e.employee_number) === normEmp(p)) ? p : ""));
      setRows(null);
    })();
    return () => { dead = true; };
  }, [office]);

  const emp = useMemo(() => emps.find((e) => normEmp(e.employee_number) === normEmp(empNo)), [emps, empNo]);

  const search = async () => {
    if (!office || !emp) { toast.error("事業所と職員を選んでください"); return; }
    setLoading(true);
    setTravelNote("");
    try {
      const ym = month.replace("-", "");            // YYYYMM
      const year = Number(month.slice(0, 4));
      const mon = Number(month.slice(5, 7));
      const monthStart = `${month}-01`;

      // ── 実績 (その事業所・その月ぶん)。職員で絞るのは 0 埋めの揺れがあるので取ってから ──
      const recs: Rec[] = [];
      {
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase.from("payroll_service_records")
            .select("id,employee_number,service_date,dispatch_start_time,dispatch_end_time,calc_duration,service_code,service_type,client_number,client_name,office_number,time_period,holiday_type,accompanied_visit,amount")
            .eq("processing_month", ym).eq("office_number", office.office_number)
            .order("id").range(from, from + PAGE - 1);
          // ⚠ 読み込みエラーを「データの終わり」と扱わない (途中で切れると件数も金額も静かに減る)
          if (error) throw new Error(`実績の読み込みに失敗: ${error.message}`);
          if (!data || data.length === 0) break;
          recs.push(...(data as Rec[]));
          if (data.length < PAGE) break;
        }
      }
      const mine = recs.filter((r) => normEmp(r.employee_number) === normEmp(emp.employee_number));

      // ── 出勤簿 ──
      const { data: attData, error: attErr } = await supabase.from("payroll_attendance_records")
        .select("employee_number,day,break_time,work_hours,overtime_daily,overtime_weekly,start_time_1,end_time_1,start_time_2,end_time_2,start_time_3,end_time_3,start_time_4,end_time_4,start_time_5,end_time_5")
        .eq("year", year).eq("month", mon).eq("office_number", office.office_number);
      if (attErr) throw new Error(`出勤簿の読み込みに失敗: ${attErr.message}`);
      const atts = ((attData ?? []) as Att[]).filter((a) => normEmp(a.employee_number) === normEmp(emp.employee_number));
      const attByDay = new Map(atts.map((a) => [a.day, a]));

      // ── 時給を引くための対応表 (給与計算の画面と同じ引き方。visit-pay.ts を共有) ──
      const [mapRes, catRes, offRes, rateRes, juho, sougou, doukou] = await Promise.all([
        supabase.from("payroll_service_type_mappings").select("service_code,category_id"),
        supabase.from("payroll_service_categories").select("id,name"),
        supabase.from("payroll_offices").select("id,office_number"),
        supabase.from("payroll_category_hourly_rates").select("category_id,office_id,hourly_rate,effective_from"),
        getJuhoShortVisitRates(supabase),
        getSougouSeikatsuRates(supabase),
        getDoukouEngoFlatRates(supabase),
      ]);
      for (const [label, r] of [["類型の対応", mapRes], ["類型", catRes], ["事業所", offRes], ["時給", rateRes]] as const) {
        if (r.error) throw new Error(`${label}の読み込みに失敗: ${r.error.message}`);
      }
      if (juho.error || sougou.error || doukou.error) throw new Error(`時給の設定の読み込みに失敗: ${juho.error ?? sougou.error ?? doukou.error}`);

      const mappingMap = new Map((mapRes.data ?? []).map((m: { service_code: string; category_id: string }) => [m.service_code, m.category_id]));
      const categoryMap = new Map((catRes.data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
      const officeMap = new Map((offRes.data ?? []).map((o: { id: string; office_number: string }) => [o.office_number, o.id]));
      // 時給は履歴。対象月の月初以前で最新の行を使う (給与計算の画面と同じ)
      const rateMap = new Map<string, number>();
      {
        const fromOf = new Map<string, string>();
        for (const r of (rateRes.data ?? []) as { category_id: string; office_id: string; hourly_rate: number; effective_from: string | null }[]) {
          const f = r.effective_from ?? "2000-01-01";
          if (f > monthStart) continue;
          const k = `${r.office_id}:${r.category_id}`;
          if ((fromOf.get(k) ?? "") <= f) { fromOf.set(k, f); rateMap.set(k, r.hourly_rate); }
        }
      }
      const ctx: VisitRateContext = {
        mappingMap, categoryMap, officeMap, rateMap,
        juhoShortRates: juho.rates, sougouRates: sougou.rates, doukouFlatRates: doukou.rates,
        lifeSupportCategoryId: [...categoryMap.entries()].find(([, n]) => n === "生活援助")?.[0] ?? null,
      };

      // ── 移動時間。★ Google には取りに行かず **キャッシュにあるぶんだけ** 出す ──
      //   (以前 全員の全区間を先に取りに行って 月の API 上限 20,000 件を使い切った事故がある)
      const travelByVisit = new Map<string, number>();   // 実績 id → その訪問に入るまでの移動 (分)
      {
        const { data: cl, error: clErr } = await supabase.from("payroll_clients")
          .select("client_number,address,map_address,map_latitude,map_longitude").eq("office_id", office.id);
        if (clErr) throw new Error(`利用者の読み込みに失敗: ${clErr.message}`);
        const addrOf = new Map(((cl ?? []) as { client_number: string; address: string; map_address: string | null; map_latitude: number | null; map_longitude: number | null }[])
          .map((c) => [c.client_number, (c.map_latitude != null && c.map_longitude != null) ? `${c.map_latitude},${c.map_longitude}` : (c.map_address?.trim() || c.address)]));

        const dayMap = new Map<string, (VisitForRoute & { id: string })[]>();
        for (const r of mine) {
          const a = addrOf.get(r.client_number);
          if (!a?.trim()) continue;
          if (!dayMap.has(r.service_date)) dayMap.set(r.service_date, []);
          dayMap.get(r.service_date)!.push({ id: r.id, client_number: r.client_number, client_address: a, dispatch_start_time: r.dispatch_start_time, dispatch_end_time: r.dispatch_end_time });
        }
        const origins = [...new Set([...dayMap.values()].flat().map((v) => v.client_address))];
        const distMap = new Map<string, { distance_meters: number; duration_seconds: number }>();
        if (origins.length > 0) {
          // ⚠ .in() は 350 件を超えると seq scan に落ちるので 150 ずつに割る
          for (let i = 0; i < origins.length; i += 150) {
            const chunk = origins.slice(i, i + 150);
            for (let from = 0; ; from += 1000) {
              const { data, error } = await supabase.from("payroll_distance_cache")
                .select("origin_address,destination_address,distance_meters,duration_seconds")
                .in("origin_address", chunk).order("id").range(from, from + 999);
              if (error) throw new Error(`移動距離のキャッシュの読み込みに失敗: ${error.message}`);
              if (!data || data.length === 0) break;
              for (const r of data as { origin_address: string; destination_address: string; distance_meters: number; duration_seconds: number }[]) {
                distMap.set(`${r.origin_address}|||${r.destination_address}`, { distance_meters: r.distance_meters, duration_seconds: r.duration_seconds });
              }
              if (data.length < 1000) break;
            }
          }
        }
        let missing = 0, total = 0;
        for (const [date, visits] of dayMap) {
          const sorted = [...visits].sort((a, b) => a.dispatch_start_time.localeCompare(b.dispatch_start_time));
          const day = calcDayRoute(date, "", sorted, distMap);
          if (!day) continue;
          // legs は 自宅→1件目, 1→2, …, 最後→自宅 の順。訪問間の区間 (i 番目) は sorted[i] に入る移動
          const between = day.legs.filter((l) => !l.is_home_leg);
          for (let i = 0; i < sorted.length - 1; i++) {
            total++;
            const key = `${sorted[i].client_address}|||${sorted[i + 1].client_address}`;
            if (!distMap.has(key)) { missing++; continue; }
            const leg = between.find((l) => l.from === sorted[i].client_address && l.to === sorted[i + 1].client_address);
            if (!leg) { missing++; continue; }
            // 2 時間以上空いた区間は移動に数えない (給与計算と同じ規則)
            travelByVisit.set(sorted[i + 1].id, leg.gap_excluded ? 0 : Math.floor(leg.duration_sec / 60));
          }
        }
        if (total > 0 && missing > 0) {
          setTravelNote(`移動時間は ${total - missing}/${total} 区間ぶんだけ出ています (残りは距離のキャッシュに無いので空欄。/移動距離計算 を回すと入ります)`);
        } else if (total === 0) {
          setTravelNote("移動時間の元になる区間がありません (利用者の住所が未登録か、訪問が 1 日 1 件のみ)");
        }
      }

      // ── 行を組み立てる ──
      const dates = [...new Set(mine.map((r) => String(r.service_date).replace(/\//g, "-").slice(0, 10)))];
      for (const a of atts) {
        const d = `${month}-${String(a.day).padStart(2, "0")}`;
        if (!dates.includes(d)) dates.push(d);
      }
      dates.sort();

      const out: Row[] = [];
      for (const d of dates) {
        const day = Number(d.slice(8, 10));
        const a = attByDay.get(day);
        const dayRecs = mine
          .filter((r) => String(r.service_date).replace(/\//g, "-").slice(0, 10) === d)
          .sort((x, y) => t5(x.dispatch_start_time).localeCompare(t5(y.dispatch_start_time)));
        if (a) {
          const sp = attSpan(a);
          out.push({
            kind: "att", date: d, start: sp.start, end: sp.end, brk: t5(a.break_time),
            workMin: a.work_hours ? parseDurationMinutes(a.work_hours) : null,
            overtime: t5(a.overtime_daily),
          });
        }
        let vSum = 0, tSum = 0, tKnown = false, paySum = 0, honoSum = 0;
        for (const r of dayRecs) {
          const p = resolveVisitPay(r, ctx);
          const travel = travelByVisit.has(r.id) ? travelByVisit.get(r.id)! : null;
          vSum += p.minutes;
          if (travel != null) { tSum += travel; tKnown = true; }
          if (p.pay != null) paySum += p.pay;
          if (r.amount != null) honoSum += r.amount;
          out.push({
            kind: "visit", date: d, rec: r, visitMin: p.minutes, travelMin: travel,
            workMin: travel == null ? null : p.minutes + travel,
            catName: p.catName, hourlyRate: p.hourlyRate, pay: p.pay,
          });
        }
        out.push({
          kind: "sub", date: d, visitMin: vSum, travelMin: tKnown ? tSum : null,
          workMin: (tKnown ? vSum + tSum : vSum) + (a?.work_hours ? parseDurationMinutes(a.work_hours) : 0),
          pay: paySum, honobono: honoSum, overtime: t5(a?.overtime_daily),
        });
      }
      setRows(out);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setRows(null);
    } finally {
      setLoading(false);
    }
  };

  // 表示する行 (絞りこみ)
  const shownRows = useMemo(() => {
    if (!rows) return null;
    const keepVisit = (r: VisitRow) => {
      if (fClient && !String(r.rec.client_number).includes(fClient) && !(r.rec.client_name ?? "").includes(fClient)) return false;
      if (fCode && !String(r.rec.service_code).includes(fCode)) return false;
      if (fDoukou && !(r.rec.accompanied_visit ?? "").trim()) return false;
      const tp = r.rec.time_period ?? "";
      if (fYoruasa && !/夜朝|夜間|早朝/.test(tp)) return false;
      if (fShinya && !tp.includes("深夜")) return false;
      if (fHoliday && !/日祭|休日/.test(r.rec.holiday_type ?? "")) return false;
      return true;
    };
    const anyFilter = !!(fClient || fCode || fDoukou || fYoruasa || fShinya || fHoliday);
    const out: Row[] = [];
    for (const r of rows) {
      if (r.kind === "visit") { if (keepVisit(r)) out.push(r); continue; }
      // 絞りこみ中は 出勤簿行と小計は出さない (絞った結果の小計ではないので誤解の元)
      if (anyFilter) continue;
      out.push(r);
    }
    if (subtotalOnly) return out.filter((r) => r.kind === "sub");
    return out;
  }, [rows, fClient, fCode, fDoukou, fYoruasa, fShinya, fHoliday, subtotalOnly]);

  const total = useMemo(() => {
    if (!shownRows) return null;
    const v = shownRows.filter((r): r is VisitRow => r.kind === "visit");
    if (v.length > 0) {
      return {
        count: v.length,
        visitMin: v.reduce((s, r) => s + r.visitMin, 0),
        pay: v.reduce((s, r) => s + (r.pay ?? 0), 0),
        honobono: v.reduce((s, r) => s + (r.rec.amount ?? 0), 0),
      };
    }
    const sub = shownRows.filter((r): r is SubRow => r.kind === "sub");
    return {
      count: 0,
      visitMin: sub.reduce((s, r) => s + r.visitMin, 0),
      pay: sub.reduce((s, r) => s + r.pay, 0),
      honobono: sub.reduce((s, r) => s + r.honobono, 0),
    };
  }, [shownRows]);

  /**
   * ほのぼのの金額 (MEISAI の「金額」列) が 1 件でも入っているか。
   * ⚠ 全件 空のまま 0 円として比べると「差 181,549 円」のように出て **取込漏れを金額のズレと読み違える**
   *   (2026-09-26 に ちはら台 202607 で実際にそう見えた)。入っていないときは 比べない。
   */
  const hasHonobono = useMemo(
    () => !!rows?.some((r) => r.kind === "visit" && r.rec.amount != null),
    [rows],
  );

  const anyFilter = !!(fClient || fCode || fDoukou || fYoruasa || fShinya || fHoliday);
  const clearFilters = () => { setFClient(""); setFCode(""); setFDoukou(false); setFYoruasa(false); setFShinya(false); setFHoliday(false); setSubtotalOnly(false); };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-2xl font-bold">サービス記録一覧</h2>
        <p className="text-sm text-muted-foreground">旧システムの「実績確認」と同じ並び。1 行 = 1 訪問で、日付ごとに小計を出します。<b>この画面は読むだけ</b>です。</p>
      </div>

      {/* 選ぶところ */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <label className="text-sm">事業所
          <select className="block mt-1 h-9 w-56 rounded-md border bg-background px-2 text-sm" value={officeId} onChange={(e) => { setOfficeId(e.target.value); setRows(null); }}>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.short_name || o.name}</option>)}
          </select>
        </label>
        <label className="text-sm">稼働年月
          <Input type="month" value={month} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setRows(null); } }} className="mt-1 h-9 w-36" />
        </label>
        <label className="text-sm">職員
          <select className="block mt-1 h-9 w-56 rounded-md border bg-background px-2 text-sm" value={empNo} onChange={(e) => { setEmpNo(e.target.value); setRows(null); }}>
            <option value="">— 選んでください ({emps.length}名) —</option>
            {emps.map((e) => (
              <option key={e.id} value={e.employee_number}>
                {e.name} ({e.employee_number}) {e.salary_type}{e.employment_status === "退職者" ? " ※退職" : ""}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={search} disabled={loading || !emp}>{loading ? "読み込み中…" : "検 索"}</Button>
        {emp && (
          <p className="text-xs text-muted-foreground">
            {emp.role_type || "—"} / {emp.job_type || "—"} ・ {emp.salary_type}
            {emp.salary_type === "月給" && <span className="ml-1 text-amber-700">※ 月給者ですが 時給の金額を出します (支給額ではありません)</span>}
          </p>
        )}
      </div>

      {/* 絞りこみ */}
      {rows && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3 text-sm">
          <label>利用者 <Input value={fClient} onChange={(e) => setFClient(e.target.value)} placeholder="コード / 氏名" className="ml-1 inline-block h-8 w-40" /></label>
          <label>サービスコード <Input value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder="111111" className="ml-1 inline-block h-8 w-28" /></label>
          {([["同行訪問", fDoukou, setFDoukou], ["夜朝", fYoruasa, setFYoruasa], ["深夜", fShinya, setFShinya], ["日祭・休日", fHoliday, setFHoliday]] as const).map(([label, v, set]) => (
            <label key={label} className="inline-flex cursor-pointer items-center gap-1">
              <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} className="h-3.5 w-3.5" />{label}
            </label>
          ))}
          <label className="inline-flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={subtotalOnly} onChange={(e) => setSubtotalOnly(e.target.checked)} className="h-3.5 w-3.5" />小計のみ表示
          </label>
          <Button variant="ghost" size="sm" onClick={clearFilters}>クリア</Button>
          {anyFilter && <span className="text-xs text-amber-700">⚠ 絞りこみ中は 出勤簿の行と小計を出しません (絞った結果の小計ではないため)</span>}
        </div>
      )}

      {travelNote && <p className="text-xs text-amber-700">⚠ {travelNote}</p>}

      {shownRows && (
        <>
          <div className="max-h-[calc(100vh-22rem)] overflow-auto rounded-lg border">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <TH sticky>日付</TH>
                  <TH right>開始</TH><TH right>終了</TH><TH right>休憩</TH>
                  <TH right>訪問<br />時間</TH><TH right>移動<br />時間</TH><TH right>勤務<br />時間</TH>
                  <TH>利用者コード</TH><TH>利用者名</TH><TH>サービス名</TH>
                  <TH>休日<br />区分</TH><TH>時間帯</TH>
                  <TH right>金額</TH>
                  <TH right>ほのぼの<br />の金額{!hasHonobono && <span className="block text-[10px] font-normal text-muted-foreground">未取込</span>}</TH>
                  <TH right>残業<br />時間</TH>
                  <TH right>休日残業<br />時間</TH>
                  <TH right>週勤務<br />時間</TH>
                  <TH right>常勤換算<br />時間</TH>
                </tr>
              </thead>
              <tbody>
                {shownRows.length === 0 && (
                  <tr><td colSpan={18} className="border-t px-3 py-6 text-center text-muted-foreground">該当する行がありません</td></tr>
                )}
                {shownRows.map((r, i) => {
                  if (r.kind === "att") {
                    return (
                      <tr key={`a-${r.date}`} className="bg-muted/20 text-muted-foreground">
                        <td className="sticky left-0 z-10 border-t border-r bg-background px-2 py-1 whitespace-nowrap">{mmdd(r.date)}<span className="ml-1 text-[10px]">({weekday(r.date)})</span></td>
                        <td className="border-t px-2 py-1 text-right tabular-nums">{r.start}</td>
                        <td className="border-t px-2 py-1 text-right tabular-nums">{r.end}</td>
                        <td className="border-t px-2 py-1 text-right tabular-nums">{r.brk}</td>
                        <td className="border-t" /><td className="border-t" />
                        <td className="border-t px-2 py-1 text-right tabular-nums">{hm(r.workMin)}</td>
                        <td className="border-t px-2 py-1 text-xs" colSpan={5}>出勤簿</td>
                        <td className="border-t" /><td className="border-t" />
                        <td className="border-t px-2 py-1 text-right tabular-nums">{r.overtime}</td>
                        <td className="border-t" /><td className="border-t" /><td className="border-t" />
                      </tr>
                    );
                  }
                  if (r.kind === "sub") {
                    return (
                      <tr key={`s-${r.date}`} className="bg-primary/5 font-medium">
                        <td className="sticky left-0 z-10 border-t border-r bg-background px-2 py-1 whitespace-nowrap">小計 {mmdd(r.date)}</td>
                        <td className="border-t" /><td className="border-t" /><td className="border-t" />
                        <td className="border-t px-2 py-1 text-right tabular-nums">{hm(r.visitMin)}</td>
                        <td className="border-t px-2 py-1 text-right tabular-nums">{hm(r.travelMin)}</td>
                        <td className="border-t px-2 py-1 text-right tabular-nums">{hm(r.workMin)}</td>
                        <td className="border-t" colSpan={5} />
                        <td className="border-t px-2 py-1 text-right tabular-nums">{yen(r.pay)}</td>
                        <td className="border-t px-2 py-1 text-right tabular-nums text-muted-foreground">{yen(r.honobono || null)}</td>
                        <td className="border-t px-2 py-1 text-right tabular-nums">{r.overtime}</td>
                        <td className="border-t" /><td className="border-t" /><td className="border-t" />
                      </tr>
                    );
                  }
                  const prev = shownRows[i - 1];
                  const newDay = !prev || (prev.kind !== "visit" ? true : prev.date !== r.date);
                  const diff = r.pay != null && r.rec.amount != null && r.pay !== r.rec.amount;
                  return (
                    <tr key={r.rec.id} className="hover:bg-primary/5">
                      <td className={`sticky left-0 z-10 border-r bg-background px-2 py-1 whitespace-nowrap ${newDay ? "border-t" : "border-t border-t-transparent"}`}>
                        {newDay ? <>{mmdd(r.date)}<span className="ml-1 text-[10px] text-muted-foreground">({weekday(r.date)})</span></> : ""}
                      </td>
                      <td className="border-t px-2 py-1 text-right tabular-nums">{t5(r.rec.dispatch_start_time)}</td>
                      <td className="border-t px-2 py-1 text-right tabular-nums">{t5(r.rec.dispatch_end_time)}</td>
                      <td className="border-t" />
                      <td className="border-t px-2 py-1 text-right tabular-nums">{hm(r.visitMin)}</td>
                      <td className="border-t px-2 py-1 text-right tabular-nums text-muted-foreground">{hm(r.travelMin)}</td>
                      <td className="border-t px-2 py-1 text-right tabular-nums">{hm(r.workMin)}</td>
                      <td className="border-t px-2 py-1 tabular-nums whitespace-nowrap">{r.rec.client_number}</td>
                      <td className="border-t px-2 py-1 whitespace-nowrap">{r.rec.client_name ?? ""}</td>
                      <td className="border-t px-2 py-1 whitespace-nowrap">
                        {r.rec.service_type ?? r.rec.service_code}
                        {r.rec.accompanied_visit?.trim() && <span className="ml-1 rounded bg-muted px-1 text-[10px]">同行</span>}
                        <span className="ml-1 text-[10px] text-muted-foreground">{r.catName}</span>
                      </td>
                      <td className="border-t px-2 py-1 whitespace-nowrap">{r.rec.holiday_type ?? ""}</td>
                      <td className="border-t px-2 py-1 whitespace-nowrap">{r.rec.time_period ?? ""}</td>
                      <td className="border-t px-2 py-1 text-right tabular-nums" title={r.hourlyRate != null ? `時給 ${r.hourlyRate.toLocaleString()}円` : "時給が引けません"}>
                        {r.pay != null ? yen(r.pay) : <span className="text-amber-700">—</span>}
                      </td>
                      <td className={`border-t px-2 py-1 text-right tabular-nums ${diff ? "font-medium text-amber-700" : "text-muted-foreground"}`}>
                        {yen(r.rec.amount)}
                      </td>
                      <td className="border-t" /><td className="border-t" /><td className="border-t" /><td className="border-t" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {total && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
              <span>件数 <b className="tabular-nums">{total.count.toLocaleString()}</b></span>
              <span>訪問時間 <b className="tabular-nums">{hm(total.visitMin)}</b></span>
              <span>金額 (当方) <b className="tabular-nums">{yen(total.pay)}円</b></span>
              {hasHonobono ? (
                <>
                  <span className="text-muted-foreground">ほのぼのの金額 <b className="tabular-nums">{yen(total.honobono)}円</b></span>
                  {total.pay !== total.honobono && <span className="text-amber-700">差 {yen(total.pay - total.honobono)}円</span>}
                </>
              ) : (
                <span className="text-muted-foreground">ほのぼのの金額は <b>取り込まれていません</b> (MEISAI の「金額」列が空) — 比べていません</span>
              )}
            </div>
          )}

          <div className="rounded-lg border p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">⚠ この画面が出していないもの</p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li><b>週勤務時間・常勤換算時間</b> — 列だけ作ってあります。数値は後で (2026-09-26 user)</li>
              <li><b>休日残業時間</b> — 当方は 残業を 日/週でしか持っておらず、休日ぶんを分けて持っていません</li>
              <li><b>移動時間</b> — 距離のキャッシュにある区間だけ。無いところは空欄 (Google には取りに行きません。月の API 上限を使い切った事故があるため)</li>
              <li><b>出勤簿行の勤務時間</b> — 当方の出勤簿から出した値です。旧システムの同じ欄とは規則が違う可能性があります (旧システムの規則は未特定)</li>
              <li><b>0.75掛け・特日・法定休日の絞りこみ</b> — 旧システムにはありますが まだ付けていません</li>
              <li><b>金額</b> — 給与計算の画面と同じ引き方 (<code>visit-pay.ts</code> を共有)。月給者にも時給の金額を出すので <b>支給額ではありません</b></li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
