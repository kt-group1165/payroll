"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { sortOfficesByDisplayOrder } from "@/lib/office-order";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  diffItems, pickSoukatsu, type DiffContext, type ItemDiff, type DiffVerdict,
} from "@/lib/payroll/soukatsu-diff";
import {
  attendanceWorkMinutes,
  parseWorkHoursMinutes,
  type OvertimeSetting,
} from "@/lib/payroll/payroll-calc";
import { verificationItems, MINUTE_ITEMS } from "@/lib/payroll/verification-items";

/**
 * /verification 総括表との検証 (移行期だけの画面)
 *
 * 旧システムの総括表 (= 実際に払った額) と 当システムの計算結果を 職員ごと・項目ごとに比べ、
 * **直す必要があるずれ (要対応)** と **追いかけなくてよいずれ (許容)** を分けて出す。
 *
 * 総括表は payroll_soukatsu_rows (migrations/import_soukatsu_rows.mjs で取込)。
 * 当システムの値は payroll_calc_results の payload (給与計算を実行したときの保存)。
 * ⚠ 給与計算を実行していない月は比べられない。その旨を画面に出す。
 */

type OfficeRow = { id: string; office_number: string; name: string; office_type: string };
type SoukatsuRow = {
  employee_number: string; employee_name: string; sheet_kind: string;
  row_data: Record<string, unknown>;
};
type CalcPayload = {
  hourly?: Record<string, unknown>[];
  monthly?: Record<string, unknown>[];
  overtime_settings?: unknown[];
};

const norm = (n: unknown) => String(n ?? "").replace(/^0+/, "");
const yen = (n: number) => `${Math.round(n).toLocaleString()}円`;
const hhmm = (min: number) => {
  const v = Math.round(min);
  const sign = v < 0 ? "-" : "";
  return `${sign}${Math.floor(Math.abs(v) / 60)}:${String(Math.abs(v) % 60).padStart(2, "0")}`;
};
const showVal = (item: string, v: number) => (MINUTE_ITEMS.has(item) ? hhmm(v) : yen(v));
const num = (v: unknown) => (typeof v === "number" ? v : 0);

export default function VerificationContent() {
  const [offices, setOffices] = useState<OfficeRow[]>([]);
  const [officeNumber, setOfficeNumber] = useState("");
  const [month, setMonth] = useState("202607");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<{ name: string; num: string; kind: "part" | "shaseki"; total: number; soukatsuTotal: number; diffs: ItemDiff[] }[]>([]);
  const [missing, setMissing] = useState<{ onlyOurs: string[]; onlySoukatsu: string[]; unreadable: string[] }>({ onlyOurs: [], onlySoukatsu: [], unreadable: [] });
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<DiffVerdict | "すべて">("要対応");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("payroll_offices").select(`id,office_number,office_type,sort_order, ${OFFICE_MASTER_JOIN}`);
      if (error) { toast.error(`事業所の取得に失敗: ${error.message}`); return; }
      // 事業所一覧 (/offices) と同じ順 (2026-10-08 user)
      const list = sortOfficesByDisplayOrder(
        (flattenOfficeMaster(data as never) as unknown as OfficeRow[])
          .filter((o) => o.office_type === "訪問介護"),
      );
      setOffices(list);
      setOfficeNumber((p) => p || list[0]?.office_number || "");
    })();
  }, []);

  const run = useCallback(async () => {
    if (!officeNumber) return;
    setLoading(true); setNote(""); setRows([]); setMissing({ onlyOurs: [], onlySoukatsu: [], unreadable: [] });
    const [sRes, cRes, aRes, empRes, ofRes] = await Promise.all([
      supabase.from("payroll_soukatsu_rows").select("employee_number,employee_name,sheet_kind,row_data")
        .eq("processing_month", month).eq("office_number", officeNumber),
      supabase.from("payroll_calc_results").select("payload,calculated_at")
        .eq("processing_month", month).eq("office_number", officeNumber).maybeSingle(),
      supabase.from("payroll_attendance_records")
        .select("employee_number,start_time_1,end_time_1,start_time_2,end_time_2,start_time_3,end_time_3,start_time_4,end_time_4,start_time_5,end_time_5,break_time,work_hours")
        .eq("office_number", officeNumber).eq("year", Number(month.slice(0, 4))).eq("month", Number(month.slice(4))),
      supabase.from("payroll_employees").select("employee_number,role_type,is_office_worker,office_id"),
      supabase.from("payroll_office_form_records").select("id")
        .eq("processing_month", month).eq("office_number", officeNumber).limit(1),
    ]);
    setLoading(false);
    if (sRes.error) { toast.error(`総括表の取得に失敗: ${sRes.error.message}`); return; }
    if (cRes.error) { toast.error(`計算結果の取得に失敗: ${cRes.error.message}`); return; }
    if (aRes.error) { toast.error(`出勤簿の取得に失敗: ${aRes.error.message}`); return; }
    if (empRes.error) { toast.error(`職員の取得に失敗: ${empRes.error.message}`); return; }
    if (ofRes.error) { toast.error(`事業所書式の取得に失敗: ${ofRes.error.message}`); return; }
    const officeFormEmpty = (ofRes.data ?? []).length === 0;

    const soukatsu = (sRes.data ?? []) as SoukatsuRow[];
    if (soukatsu.length === 0) { setNote("この事業所・月の総括表が取り込まれていません (migrations/import_soukatsu_rows.mjs)"); return; }
    const payload = (cRes.data?.payload ?? null) as CalcPayload | null;
    if (!payload) { setNote("この事業所・月の給与計算がまだ実行されていません。先に「給与計算」で実行してください"); return; }
    // 月給者の 残業・介護超過は 職種ごとの残業設定が要る。計算したときの設定が payload に入っている
    const otMap = new Map(
      ((payload.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]),
    );

    // 出勤簿の「勤務時間の欄」と「終了−開始−休憩」の食い違い (分)。当システムは時刻を正とするので
    // 食い違いがある人は 出勤時間・残業のずれが説明できる (user 2026-09-23 の方針)
    const hasAtt = new Set<string>();
    const gapByEmp = new Map<string, number>();
    for (const r of (aRes.data ?? []) as Record<string, unknown>[]) {
      const n = norm(r.employee_number);
      hasAtt.add(n);
      const fromTimes = attendanceWorkMinutes(r as never);
      const fromColumn = parseWorkHoursMinutes(String(r.work_hours ?? ""));
      if (fromTimes > 0 && fromTimes !== fromColumn) gapByEmp.set(n, (gapByEmp.get(n) ?? 0) + (fromTimes - fromColumn));
    }
    const roleOf = new Map((empRes.data ?? []).map((r) => [norm((r as { employee_number: string }).employee_number), String((r as { role_type: string }).role_type ?? "")]));
    // ⚠ 役職が「パート」でも 事務員の人がいる (時給の事務員 17 名)。roleType だけで見ると穴が漏れる
    const officeWorkerOf = new Set((empRes.data ?? [])
      .filter((r) => (r as { is_office_worker?: boolean }).is_office_worker)
      .map((r) => norm((r as { employee_number: string }).employee_number)));

    const sMap = new Map(soukatsu.map((r) => [`${norm(r.employee_number)}|${r.sheet_kind}`, r]));
    const out: typeof rows = [];
    const seen = new Set<string>();
    const onlyOurs: string[] = [];
    /** ② の値が読めなかった項目 (0 として比べない。画面に出す) */
    const unreadable: string[] = [];

    for (const [kind, list] of [["part", payload.hourly ?? []], ["shaseki", payload.monthly ?? []]] as const) {
      for (const e of list) {
        const n = norm(e.employee_number);
        const key = `${n}|${kind}`;
        const s = sMap.get(key);
        if (!s) { onlyOurs.push(`${String(e.employee_name)} (${n})`); continue; }
        seen.add(key);
        const ctx: DiffContext = {
          roleType: roleOf.get(n) ?? String(e.role_type ?? ""),
          attendanceGapMinutes: gapByEmp.get(n) ?? 0,
          noAttendance: !hasAtt.has(n),
          hasRateGap: num(e.unmappedCount) > 0,
          isOfficeWorker: officeWorkerOf.has(n),
          officeNumber,
          officeFormEmpty,
          // 総括表が 介護超過・夜朝・特日 を「調整手当」に畳み込んでいるか
          adjustmentFolded: pickSoukatsu(s.row_data, "調整手当") !== 0,
          // ② の「誤差」列。調整手当(内訳計) の差が これと同額なら 追いかけなくてよい (2026-10-01)
          soukatsuGosa: pickSoukatsu(s.row_data, "誤差"),
          // ★ KNOWN_DIFFS (1 件ずつ user が許容と判断した差) の照合に使う
          processingMonth: month,
          employeeNumber: n,
          // ★ みなし残業 (固定残業代) の判定に使う。★ 計算が使ったのと同じ payload から読む
          fixedOvertimePay: num((e as { settings?: { fixed_overtime_pay?: number } }).settings?.fixed_overtime_pay),
          overtimeExcessPaid: Boolean((e as { overtime_excess_paid?: boolean }).overtime_excess_paid),
          // ★ ② 自身の みなし超過分 = ②「残業代」− ②「固定残業代」
          soukatsuOvertimeExcess: pickSoukatsu(s.row_data, "残業代") - pickSoukatsu(s.row_data, "固定残業代"),
        };
        // ★ 総括表の「調整手当」= 介護超過(プラスのみ) + 夜朝深夜 + 特日 − 誤差 (2026-09-24 実測 92.7%)。
        //   当方の内訳計と この合計を突き合わせる項目を差し込む
        // 項目の組み立て・② の読み方は src/lib/payroll/verification-items.ts (scripts/check-kenmu-verification-gap.mts と共有)
        const { items, unreadable: bad } = verificationItems(e, kind, otMap, s.row_data);
        for (const b of bad) unreadable.push(`${String(e.employee_name)} (${n}) ${b.item} ${JSON.stringify(b.raw)}`);
        out.push({
          name: String(e.employee_name), num: n, kind,
          total: num(e.grand_total),
          soukatsuTotal: pickSoukatsu(s.row_data, "総支給額"),
          diffs: diffItems(items, ctx),
        });
      }
    }
    const onlySoukatsu = soukatsu
      .filter((r) => !seen.has(`${norm(r.employee_number)}|${r.sheet_kind}`) && pickSoukatsu(r.row_data, "総支給額") > 0)
      .map((r) => `${r.employee_name} (${norm(r.employee_number)})`);

    setRows(out.sort((a, b) => Math.abs(b.soukatsuTotal - b.total) - Math.abs(a.soukatsuTotal - a.total)));
    setMissing({ onlyOurs, onlySoukatsu, unreadable });
  }, [officeNumber, month]);


  // 事業所・月が決まったら照合する。setState を effect の中で直に呼ばないよう run() に閉じ込める
  useEffect(() => {
    if (!officeNumber) return;
    let cancelled = false;
    void (async () => { if (!cancelled) await run(); })();
    return () => { cancelled = true; };
  }, [officeNumber, month, run]);

  const summary = useMemo(() => {
    const c: Record<DiffVerdict, { n: number; yen: number }> = {
      要対応: { n: 0, yen: 0 }, 許容: { n: 0, yen: 0 }, 要確認: { n: 0, yen: 0 },
    };
    for (const r of rows) for (const d of r.diffs) {
      c[d.verdict].n++;
      if (!MINUTE_ITEMS.has(d.item)) c[d.verdict].yen += Math.abs(d.diff);   // 分の項目は金額に足さない
    }
    return c;
  }, [rows]);

  const shown = useMemo(
    () => rows.map((r) => ({ ...r, diffs: filter === "すべて" ? r.diffs : r.diffs.filter((d) => d.verdict === filter) }))
      .filter((r) => r.diffs.length > 0),
    [rows, filter],
  );

  const badge = (v: DiffVerdict) =>
    v === "要対応" ? "bg-red-100 text-red-800" : v === "許容" ? "bg-gray-100 text-gray-600" : "bg-amber-100 text-amber-800";

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-xl font-bold">総括表との検証</h1>
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={officeNumber} onChange={(e) => setOfficeNumber(e.target.value)}>
          {offices.map((o) => <option key={o.office_number} value={o.office_number}>{o.name}</option>)}
        </select>
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
          {["202603", "202604", "202605", "202606", "202607", "202608"].map((m) => (
            <option key={m} value={m}>{m.slice(0, 4)}年{Number(m.slice(4))}月</option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={loading}>{loading ? "照合中…" : "再照合"}</Button>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        旧システムの総括表 (= 実際に払った額) と 当システムの計算結果を 職員ごと・項目ごとに比べています。
        <b className="text-red-700">要対応</b> = 直す必要がある /
        <b className="text-gray-700"> 許容</b> = 当システムのほうが正しい・総括表側の事情で追いかけなくてよい /
        <b className="text-amber-700"> 要確認</b> = 理由がまだ分かっていない。
        移行期だけの画面です。
      </p>

      {note && <div className="mb-4 p-3 bg-amber-50 border border-amber-300 text-amber-900 rounded text-sm">⚠ {note}</div>}

      {rows.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {(["要対応", "要確認", "許容", "すべて"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setFilter(v)}
                className={`rounded-full border px-3 py-1 text-xs ${filter === v ? "bg-foreground text-background" : "bg-background"}`}>
                {v}
                {v !== "すべて" && <span className="ml-1 opacity-70">{summary[v].n}件 / {yen(summary[v].yen)}</span>}
              </button>
            ))}
          </div>

          {(missing.onlyOurs.length > 0 || missing.onlySoukatsu.length > 0 || missing.unreadable.length > 0) && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-300 text-amber-900 rounded text-sm">
              {missing.onlySoukatsu.length > 0 && <p>⚠ 総括表にあって当システムに無い: {missing.onlySoukatsu.join(" / ")}</p>}
              {missing.onlyOurs.length > 0 && <p>⚠ 当システムにあって総括表に無い: {missing.onlyOurs.join(" / ")}</p>}
              {missing.unreadable.length > 0 && <p>⚠ 総括表の値が読めない (比べていない): {missing.unreadable.join(" / ")}</p>}
            </div>
          )}

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b text-xs">
                    <th className="text-left px-3 py-2 font-medium">職員</th>
                    <th className="text-left px-3 py-2 font-medium">項目</th>
                    <th className="text-right px-3 py-2 font-medium">当システム</th>
                    <th className="text-right px-3 py-2 font-medium">総括表</th>
                    <th className="text-right px-3 py-2 font-medium">差</th>
                    <th className="text-left px-3 py-2 font-medium">判定</th>
                    <th className="text-left px-3 py-2 font-medium">理由</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => r.diffs.map((d, i) => (
                    <tr key={`${r.num}-${r.kind}-${d.item}`} className="border-b hover:bg-muted/20">
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {i === 0 ? <span>{r.name} <span className="text-xs text-muted-foreground">({r.num} / {r.kind === "part" ? "パート" : "提責・社員"})</span></span> : ""}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{d.item}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{showVal(d.item, d.ours)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{showVal(d.item, d.soukatsu)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${d.diff > 0 ? "text-red-700" : "text-blue-700"}`}>
                        {d.diff > 0 ? "+" : ""}{MINUTE_ITEMS.has(d.item) ? hhmm(d.diff) : Math.round(d.diff).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5"><span className={`rounded-full px-2 py-0.5 text-xs ${badge(d.verdict)}`}>{d.verdict}</span></td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{d.reason}</td>
                    </tr>
                  )))}
                  {shown.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">この分類のずれはありません</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
