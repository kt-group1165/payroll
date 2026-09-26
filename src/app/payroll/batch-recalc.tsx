"use client";

/**
 * まとめて再計算 (2026-09-27)。給与計算の結果 (payroll_calc_results) を 事業所×月 ごとに 1 件ずつ順に作り直す。
 *
 * ★ 1 件の計算は 画面の「給与計算を実行」と同じ関数 (page.tsx calculateFor) を呼ぶ。
 *   同じ関数・同じ環境・同じログインで動くので、1 件ずつ押したときと同じ結果になる (同一性を構造で担保)。
 * ★ 確定済みの月は触らない (calculateFor 自体も上書きしない)。
 * ★ 再開: この回の開始時刻より calculated_at が新しいものは飛ばす。何度押しても同じところまで進むだけ。
 * ★ DB 負荷の手当て: 1 件ずつ・間を 3 秒あける / 各件の前に軽いクエリで応答時間を測り 2 秒を超えたら自動で一時停止 /
 *   旧システムの職員表 (1,656 行) は この回の間だけ 1 回読んで使い回す (lib/supabase/batch-cache-fetch.ts)
 */
import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { canOverwriteResult, type MonthlyStatus } from "@/lib/payroll/monthly-status";
import { CALC_INPUT_SOURCES, classifyCalcFreshness, type CalcStamp, type EmployeeRef } from "@/lib/payroll/calc-freshness";
import { setBatchCache } from "@/lib/supabase/batch-cache-fetch";

type StatusObj = { status: MonthlyStatus; confirmed_at: string | null; confirmed_by: string | null } | null;
type OfficeLite = { id: string; office_number: string; name: string };
type ItemState = "待ち" | "実行中" | "済" | "失敗" | "確定のため飛ばし" | "この回で計算済み";
type Item = {
  key: string; officeId: string; officeNumber: string; officeName: string; month: string;
  calculatedAt: string; status: StatusObj; reasons: string[]; selected: boolean;
  state: ItemState; note: string;
};

const RUN_START_KEY = "payroll:batchRecalc:runStart";
const PAUSE_BETWEEN_MS = 3000;
const SLOW_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readRunStart = (): string | null => { try { return localStorage.getItem(RUN_START_KEY); } catch { return null; } };
const writeRunStart = (v: string | null) => { try { if (v) localStorage.setItem(RUN_START_KEY, v); else localStorage.removeItem(RUN_START_KEY); } catch { /* 保存できなくても続行 (再開の起点が画面を閉じると消えるだけ) */ } };

/** 1000 行ずつ全件読む (PostgREST の上限対策。order 必須) */
async function readAll(table: string, select: string, filter: (q: ReturnType<ReturnType<typeof supabase.from>["select"]>) => typeof q, orderCol: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(supabase.from(table).select(select)).order(orderCol).range(from, from + 999);
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export function BatchRecalc({ offices, calculateFor, getLastError }: {
  offices: OfficeLite[];
  calculateFor: (officeId: string, month: string, status: StatusObj) => Promise<void>;
  getLastError: () => string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState<string>("");
  const [message, setMessage] = useState("");
  const [cutoff, setCutoff] = useState("");
  const stopRef = useRef(false);
  const resumeRef = useRef<(() => void) | null>(null);

  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function loadList() {
    setLoadingList(true); setMessage("");
    try {
      const calc = (await readAll("payroll_calc_results", "office_number,processing_month,calculated_at", (q) => q, "office_number")) as unknown as CalcStamp[];
      const stRows = await readAll("payroll_monthly_status", "office_number,processing_month,status,confirmed_at,confirmed_by", (q) => q, "office_number");
      const statusOf = new Map(stRows.map((r) => [`${r.office_number}|${r.processing_month}`, { status: r.status as MonthlyStatus, confirmed_at: (r.confirmed_at as string) ?? null, confirmed_by: (r.confirmed_by as string) ?? null }]));
      // 古さの判定は scripts/check-calc-freshness.mts と同じ共通関数 (calc-freshness.ts) を使う
      const minAt = calc.map((c) => c.calculated_at).sort()[0] ?? "";
      const rowsByTable = new Map<string, Record<string, unknown>[]>();
      for (const src of CALC_INPUT_SOURCES) {
        rowsByTable.set(src.table, minAt ? await readAll(src.table, src.select, (q) => q.gt(src.tsCol, minAt), src.select.split(",")[0]) : []);
      }
      const { data: po, error: poErr } = await supabase.from("payroll_offices").select("id,office_number");
      if (poErr) throw new Error(`事業所の取得に失敗: ${poErr.message}`);
      const officeIdToNumber = new Map((po ?? []).map((p) => [p.id as string, p.office_number as string]));
      const ids = new Set<string>();
      for (const src of CALC_INPUT_SOURCES) if (src.level === "employee" && !src.select.includes("office_id")) for (const r of rowsByTable.get(src.table) ?? []) ids.add(String(r.employee_id));
      const employees = new Map<string, EmployeeRef>();
      const idList = [...ids];
      for (let i = 0; i < idList.length; i += 150) {
        const { data, error } = await supabase.from("payroll_employees").select("id,employee_number,office_id").in("id", idList.slice(i, i + 150));
        if (error) throw new Error(`職員の取得に失敗: ${error.message}`);
        for (const e of data ?? []) { const o = officeIdToNumber.get(e.office_id as string); if (o) employees.set(e.id as string, { office_number: o, employee_number: e.employee_number as string }); }
      }
      const { person, officeMonth } = classifyCalcFreshness(calc, rowsByTable, employees, officeIdToNumber);
      const reasonsOf = new Map<string, Set<string>>();
      for (const [k, s] of person) { const [o, , m] = k.split("|"); const km = `${o}|${m}`; if (!reasonsOf.has(km)) reasonsOf.set(km, new Set()); for (const w of s) reasonsOf.get(km)!.add(w); }
      for (const [k, s] of officeMonth) { if (!reasonsOf.has(k)) reasonsOf.set(k, new Set()); for (const w of s) reasonsOf.get(k)!.add(w); }
      const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));
      const cutIso = cutoff ? new Date(cutoff).toISOString() : "";
      const list: Item[] = calc
        .filter((c) => officeByNumber.has(c.office_number))
        .map((c): Item => {
          const o = officeByNumber.get(c.office_number)!;
          const key = `${c.office_number}|${c.processing_month}`;
          const status = statusOf.get(key) ?? null;
          const reasons = [...(reasonsOf.get(key) ?? [])];
          const overwritable = !status || canOverwriteResult(status.status);
          const stale = reasons.length > 0 || (!!cutIso && c.calculated_at < cutIso);
          return { key, officeId: o.id, officeNumber: c.office_number, officeName: o.name, month: c.processing_month, calculatedAt: c.calculated_at, status, reasons, selected: overwritable && stale, state: overwritable ? "待ち" : "確定のため飛ばし", note: "" };
        })
        .sort((a, b) => (a.officeNumber + a.month).localeCompare(b.officeNumber + b.month));
      setItems(list);
      setMessage(`計算結果 ${calc.length} 件中、この画面の事業所 ${list.length} 件。既定で選んだもの (確定済みでなく 古いもの): ${list.filter((x) => x.selected).length} 件`);
    } catch (e) {
      setMessage(`★ 対象の読み込みに失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingList(false);
    }
  }

  async function probe(): Promise<number> {
    const t0 = performance.now();
    await supabase.from("payroll_offices").select("id").limit(1);
    return performance.now() - t0;
  }

  async function run(onlyFailed: boolean) {
    const targets = items.filter((x) => (onlyFailed ? x.state === "失敗" : x.selected));
    if (targets.length === 0) { setMessage("対象がありません"); return; }
    let runStart = readRunStart();
    if (!runStart) { runStart = new Date().toISOString(); writeRunStart(runStart); }
    stopRef.current = false; setRunning(true); setPaused(""); setBatchCache(true);
    try {
      for (let i = 0; i < targets.length; i++) {
        const it = targets[i];
        if (stopRef.current) { setMessage("止めました。もう一度押すと続きから再開します"); break; }
        if (it.status && !canOverwriteResult(it.status.status)) { patch(it.key, { state: "確定のため飛ばし" }); continue; }
        // 再開: この回の開始より後に計算済みなら飛ばす (何度押しても同じ結果)
        const { data: cur, error: curErr } = await supabase.from("payroll_calc_results").select("calculated_at").eq("office_number", it.officeNumber).eq("processing_month", it.month).maybeSingle();
        if (curErr) { patch(it.key, { state: "失敗", note: `計算日時の取得に失敗: ${curErr.message}` }); continue; }
        if (cur && (cur.calculated_at as string) > runStart) { patch(it.key, { state: "この回で計算済み", calculatedAt: cur.calculated_at as string }); continue; }
        // DB が詰まっていたら自動で一時停止 (他セッションも同じ DB を読んでいる)
        const ms = await probe();
        if (ms > SLOW_MS) {
          setPaused(`DB の応答が ${Math.round(ms)}ms かかっています (基準 ${SLOW_MS}ms)。一時停止しました。落ち着いたら「再開」を押してください`);
          await new Promise<void>((res) => { resumeRef.current = res; });
          setPaused("");
          if (stopRef.current) { setMessage("止めました。もう一度押すと続きから再開します"); break; }
        }
        patch(it.key, { state: "実行中", note: "" });
        setMessage(`${i + 1} / ${targets.length} 件目: ${it.officeName} ${it.month}`);
        try {
          await calculateFor(it.officeId, it.month, it.status);
        } catch (e) {
          patch(it.key, { state: "失敗", note: e instanceof Error ? e.message : String(e) });
          continue;
        }
        const { data: after } = await supabase.from("payroll_calc_results").select("calculated_at").eq("office_number", it.officeNumber).eq("processing_month", it.month).maybeSingle();
        if (after && (after.calculated_at as string) > runStart) patch(it.key, { state: "済", calculatedAt: after.calculated_at as string });
        else patch(it.key, { state: "失敗", note: getLastError() || "計算結果が保存されませんでした (画面上部のエラー表示を確認)" });
        if (i < targets.length - 1) await sleep(PAUSE_BETWEEN_MS);
      }
    } finally {
      setBatchCache(false); setRunning(false); setPaused("");
    }
  }

  const counts = items.reduce<Record<string, number>>((m, x) => { m[x.state] = (m[x.state] ?? 0) + 1; return m; }, {});
  const runStart = readRunStart();

  return (
    <div className="mt-6 rounded border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">まとめて再計算</span>
        <label className="text-xs text-muted-foreground">この日時より前に計算したものも対象
          <input type="datetime-local" className="ml-1 border rounded px-1 py-0.5 text-xs bg-background" value={cutoff} onChange={(e) => setCutoff(e.target.value)} disabled={running} />
        </label>
        <Button size="sm" variant="outline" onClick={() => void loadList()} disabled={running || loadingList}>{loadingList ? "読み込み中…" : "対象を読み込む"}</Button>
        <Button size="sm" onClick={() => void run(false)} disabled={running || items.length === 0}>{runStart ? "続きから再開" : "選んだものを再計算"}</Button>
        <Button size="sm" variant="outline" onClick={() => void run(true)} disabled={running || !counts["失敗"]}>失敗だけ出し直す</Button>
        <Button size="sm" variant="destructive" onClick={() => { stopRef.current = true; resumeRef.current?.(); }} disabled={!running}>止める (今の 1 件が終わったら)</Button>
        {paused && <Button size="sm" onClick={() => resumeRef.current?.()}>再開</Button>}
        <Button size="sm" variant="ghost" onClick={() => setItems((xs) => xs.map((x) => ({ ...x, selected: x.state !== "確定のため飛ばし" })))} disabled={running || items.length === 0}>全部選ぶ</Button>
        <Button size="sm" variant="ghost" onClick={() => setItems((xs) => xs.map((x) => ({ ...x, selected: false })))} disabled={running || items.length === 0}>全部外す</Button>
        <Button size="sm" variant="ghost" onClick={() => { writeRunStart(null); setItems((xs) => xs.map((x) => ({ ...x, state: x.state === "確定のため飛ばし" ? x.state : "待ち", note: "" }))); }} disabled={running}>新しく始める</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        1 件ずつ順に「給与計算を実行」と同じ計算をします。確定済みの月は触りません。間を {PAUSE_BETWEEN_MS / 1000} 秒あけ、DB の応答が {SLOW_MS / 1000} 秒を超えたら自動で止まります。
        {runStart && <> この回の開始: {new Date(runStart).toLocaleString("ja-JP")} (これより後に計算済みのものは飛ばします)</>}
        ⚠ 実行中は 他の画面・セッションで 計算結果から金額を測らないでください (古い結果と新しい結果が混ざります)。
      </p>
      {message && <p className="mt-2">{message}</p>}
      {paused && <p className="mt-2 text-amber-700">{paused}</p>}
      {items.length > 0 && (
        <>
          <p className="mt-2 text-xs">{Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" / ")}</p>
          <div className="mt-2 max-h-80 overflow-auto border rounded">
            <table className="w-full text-xs">
              <thead><tr className="bg-muted/50"><th className="px-2 py-1"></th><th className="px-2 py-1 text-left">事業所</th><th className="px-2 py-1">月</th><th className="px-2 py-1">計算日時</th><th className="px-2 py-1">状態</th><th className="px-2 py-1 text-left">古い理由 / メモ</th></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.key} className="border-t">
                    <td className="px-2 py-1"><input type="checkbox" checked={x.selected} disabled={running || x.state === "確定のため飛ばし"} onChange={(e) => patch(x.key, { selected: e.target.checked })} /></td>
                    <td className="px-2 py-1">{x.officeName}</td>
                    <td className="px-2 py-1 text-center">{x.month}</td>
                    <td className="px-2 py-1 text-center">{new Date(x.calculatedAt).toLocaleString("ja-JP")}</td>
                    <td className="px-2 py-1 text-center">{x.state}</td>
                    <td className="px-2 py-1">{x.note || x.reasons.slice(0, 3).join(", ")}{!x.note && x.reasons.length > 3 ? ` 他${x.reasons.length - 3}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
