/**
 * ファイル取込 (payroll_office_form_records) の行を、事業所書式入力 (Web) の行の形に逆射影する (2026-10-06)。
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 事業所書式は「画面で入れる」と「ファイルで取り込む」の両方を使えるようにする (user 2026-10-06。
 * いずれは画面の入力に統一)。給与計算は (職員 × 項目) 単位で 画面の入力がファイルに勝つ
 * (to-form-records.ts mergeOfficeFormSources)。
 * ★ ところが画面にはファイルの値が出ていなかったので、画面で 1 項目入れると
 *   その人のファイルの値が 見えないまま 画面の値に置き換わる。
 * → 画面にファイルの値を出し、「画面で直す」でそのまま画面の入力に写せるようにする。その写しに使う。
 *
 * ── 守ること ──────────────────────────────────────────────────────────────
 * ★ 写した後の給与計算の結果が 写す前と同じであること。
 *   scripts/check-office-input-roundtrip.mts が 実データ全件で
 *   「ファイルの行 → この関数 → to-form-records → computeSummary」が 元の computeSummary と一致するかを見る。
 * ★ 写せない形は 写さない (canAdopt=false と理由を返す)。黙って形を変えない:
 *   - 日時項目 (研修など) で 1 行に日付が複数ある (時刻は 1 組しか無いので 日ごとに分けると時間が倍になる)
 *   - 日付が読めない
 */

import { normalizeYM, type OfficeFormRecord } from "@/lib/payroll/payroll-calc";
import { OFFICE_INPUT_ITEM_BY_NAME, parseHHMM, type OfficeInputCategory, type OfficeInputEntryInput } from "./types";
import { normEmp } from "./to-form-records";

/** ファイルの item_date 1 つ ("6/3" / "6月3日") → 'YYYY-MM-DD'。年は 処理月から (12 月 ↔ 1 月 のまたぎも見る) */
export function itemDateToDateValue(token: string, billingMonth: string): string | null {
  const m = /^\s*(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*日?\s*$/.exec(token);
  if (!m) return null;
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const by = Number(billingMonth.slice(0, 4)), bm = Number(billingMonth.slice(5, 7));
  // 処理月が 1 月で 12 月の日付 → 前年 / 処理月が 12 月で 1 月の日付 → 翌年
  const y = bm === 1 && mo === 12 ? by - 1 : bm === 12 && mo === 1 ? by + 1 : by;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** ファイルの item_date (カンマ区切りで複数日のことがある) を日付の配列に。読めない字があれば null */
export function splitItemDates(itemDate: string | null, billingMonth: string): string[] | null {
  const raw = String(itemDate ?? "").trim();
  if (raw === "") return [];
  const out: string[] = [];
  for (const t of raw.split(/[,、，]/).map((x) => x.trim()).filter(Boolean)) {
    const v = itemDateToDateValue(t, billingMonth);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** "H:MM" / "HH:MM(:SS)" → "HH:MM:00" (DB の TIME)。空は null */
function toTime(s: string | null): string | null {
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}:00` : null;
}

/**
 * ファイルの「何月分」→ "YYYY-MM"。★ 給与計算と同じ normalizeYM で読む
 * (実データに "2026/5" / "Jul-26" / "25-Dec" が混ざる)。空は null、読めなければ undefined
 * ("206/4" のような打ち間違い。写さない)
 */
function toRefMonth(s: string | null): string | null | undefined {
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const n = normalizeYM(t);
  const m = /^(20\d{2})(\d{2})$/.exec(n);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return undefined;
  return `${m[1]}-${m[2]}`;
}

export type AdoptPlan = {
  /** 職員番号 (正規化前の元の値) */
  employee_number: string;
  item_name: string;
  category: OfficeInputCategory;
  /** 画面の入力に写す行 (employee_id は呼出元で埋める) */
  entries: Omit<OfficeInputEntryInput, "employee_id">[];
  /** 画面に出す要約 ("42.5km" / "3, 7, 18" / "2 行" など) */
  summary: string;
  /** 写せるか。false なら reason に理由 */
  canAdopt: boolean;
  reason?: string;
  /** どこから来た値か ("事業所書式" / "旧システム・総括表" など)。画面の表示用 (2026-10-08) */
  source?: string;
  /** source の詳しい中身 (ファイル名など)。title に出す */
  sourceDetail?: string;
};

/**
 * ファイルの行を (職員 × 項目) ごとにまとめ、画面の入力に写す計画を作る。
 * 画面の項目に無い item_name の行は unknown に入れて返す (黙って捨てない)。
 */
export function planAdoptFromFormRecords(
  records: OfficeFormRecord[],
  billingMonth: string,
): { plans: AdoptPlan[]; unknown: OfficeFormRecord[] } {
  const groups = new Map<string, OfficeFormRecord[]>();
  const unknown: OfficeFormRecord[] = [];
  for (const r of records) {
    if (!OFFICE_INPUT_ITEM_BY_NAME.has(r.item_name)) { unknown.push(r); continue; }
    const k = `${normEmp(r.employee_number)}|${r.item_name}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const plans: AdoptPlan[] = [];
  for (const rows of groups.values()) {
    const item = OFFICE_INPUT_ITEM_BY_NAME.get(rows[0].item_name)!;
    const base = { employee_number: rows[0].employee_number, item_name: item.name, category: item.category };
    const common = { billing_month: billingMonth, category: item.category, item_name: item.name };

    if (item.category === "数値項目" || item.category === "時間項目") {
      // ★ 空欄の行の扱いは 給与計算に合わせる (computeMeetingFee):
      //   会議の件数が空欄の行は「1 件」と数えている → 1 として写す。
      //   それ以外 (出張km・通勤km など) の空欄は 0 扱い。全部空欄なら 写すものが無いので 計画を作らない (ファイルの行が残る)
      const isMeetingCount = /会議[123]件数/.test(item.name);
      if (!isMeetingCount && rows.every((r) => r.numeric_value == null)) continue;
      const sum = rows.reduce((s, r) => s + (r.numeric_value == null ? (isMeetingCount ? 1 : 0) : Number(r.numeric_value)), 0);
      const v = Math.round(sum * 1000) / 1000;
      plans.push({
        ...base, canAdopt: true,
        summary: item.category === "時間項目" ? `${v}分` : `${v}${item.unit ?? ""}`,
        entries: [{ ...common, numeric_value: item.category === "時間項目" ? null : v, time_minutes: item.category === "時間項目" ? Math.round(v) : null }],
      });
      continue;
    }

    if (item.category === "日付項目") {
      const dates: string[] = [];
      let bad = false;
      let noDate = false;
      for (const r of rows) {
        const ds = splitItemDates(r.item_date, billingMonth);
        if (ds === null) { bad = true; break; }
        // ★ 日付の無い行は 給与計算が「1 日」と数えている (listedDateCount)。画面の入力は 日付で持つので表せない
        if (ds.length === 0) { noDate = true; break; }
        dates.push(...ds);
      }
      if (bad || noDate) {
        plans.push({ ...base, canAdopt: false, reason: bad ? "日付が読めない行がある" : "日付の無い行がある (給与計算は 1 日と数えている)", summary: rows.map((r) => r.item_date || "(日付なし)").join(" / "), entries: [] });
        continue;
      }
      const sorted = [...dates].sort();
      plans.push({
        ...base, canAdopt: true,
        summary: sorted.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join(", "),
        entries: sorted.map((d) => ({ ...common, date_value: d })),
      });
      continue;
    }

    if (item.category === "日時項目") {
      const entries: Omit<OfficeInputEntryInput, "employee_id">[] = [];
      let reason = "";
      for (const r of rows) {
        const ds = splitItemDates(r.item_date, billingMonth);
        if (ds === null) { reason = "日付が読めない行がある"; break; }
        if (ds.length > 1) { reason = "1 行に日付が複数ある (時刻が 1 組しか無いので分けられない)"; break; }
        const brk = String(r.break_time ?? "").trim();
        entries.push({
          ...common,
          date_value: ds[0] ?? null,
          start_time: toTime(r.start_time),
          end_time: toTime(r.end_time),
          break_minutes: brk === "" ? null : (parseHHMM(brk.slice(0, 5)) ?? null),
        });
      }
      if (reason) { plans.push({ ...base, canAdopt: false, reason, summary: `${rows.length} 行`, entries: [] }); continue; }
      plans.push({ ...base, canAdopt: true, summary: `${entries.length} 行`, entries });
      continue;
    }

    // 育児手当
    const refs = rows.map((r) => toRefMonth(r.year_month));
    if (refs.some((x) => x === undefined)) {
      plans.push({ ...base, canAdopt: false, reason: "「何月分」が読めない行がある", summary: rows.map((r) => r.year_month).join(" / "), entries: [] });
      continue;
    }
    const entries = rows.map((r, i) => ({
      ...common,
      numeric_value: r.amount ?? null,
      child_name: r.child_name ?? null,
      reference_month: refs[i] ?? null,
    }));
    const total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    plans.push({ ...base, canAdopt: true, summary: `${rows.length} 行 / ${total.toLocaleString()}円`, entries });
  }
  return { plans, unknown };
}
