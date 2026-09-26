/**
 * payroll_calc_results (給与計算のスナップショット) が、その後に入った入力より
 * 古いままになっていないかを検出する (2026-09-26)。
 *
 *   npx tsx scripts/check-calc-staleness.mts
 *   OFFICE=1270501180 npx tsx scripts/check-calc-staleness.mts   # 事業所を絞る
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * 給与E が おゆみ野4名の乖離を「計算式のバグではなくスナップショットが古いだけ」と
 * 突き止めた実例がある。再計算は画面(user操作)からしかできないため、
 * 「再計算前に何が変わる見込みか」「再計算しても変わらないなら何がおかしいか」を
 * 先に出しておかないと、古い payroll_calc_results.payload を見ながら
 * 「バグだ」「直った」を議論して時間を溶かすことになる。
 *
 * ⚠ これは「古さ」の検査であって「金額の正否」の検査ではない。
 *   古いと分かっても、再計算した結果が正しいとは限らない (それは他の check の仕事)。
 * ⚠ 職員番号は事業所をまたぐと重複する。必ず (office_number, employee_number) の対で引く。
 *   (2026-09-26 に 給与A・給与計算ソフト の 2 セッションがこの罠を踏んだ)
 * ⚠ 母数を必ず併記する。「古いものが N 件」だけでなく「calc_results 全 M 件中」を出す。
 *
 * 見ている入力 (payroll_calc_results.calculated_at と比べる):
 *   payroll_monthly_inputs.updated_at        (office_number, processing_month) 単位
 *   payroll_office_form_records.created_at   (office_number, processing_month) 単位
 *   payroll_attendance_records.created_at    (office_number, year/month→processing_month) 単位
 *   payroll_office_unit_prices.updated_at    事業所単位 (office_id→office_number)。
 *     effective_from <= その処理月の月末 の単価行だけを対象にする
 *     (未来の改定は、まだその月の計算には効かないので古さの判定に含めない)
 *
 * 見ていない入力 (取り込み時に calc_results が要らない/影響が別経路のもの):
 *   payroll_soukatsu_rows (突合専用。計算には使わない)
 *   payroll_employees / payroll_salary_settings の更新 (基本給等。件数が多く今回は対象外。TODO)
 */
import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const OFFICE_FILTER = process.env.OFFICE ?? null;

const nn = (s: unknown): string => String(s ?? "").replace(/^0+/, "");
const num = (v: unknown): number => {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? 0 : n;
};

async function getAll<T>(q: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`fetch failed for ${q}: ${JSON.stringify(j).slice(0, 300)}`);
    out.push(...(j as T[]));
    if (j.length < 1000) break;
  }
  return out;
}

const monthEndIso = (processingMonth: string): string => {
  const y = Number(processingMonth.slice(0, 4));
  const m = Number(processingMonth.slice(4, 6));
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  return last.toISOString().slice(0, 10);
};

type CalcRow = { office_number: string; processing_month: string; calculated_at: string };
type MonthlyInput = { office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null; updated_at: string };
type FormRecord = { office_number: string; employee_number: string; processing_month: string; item_name: string; numeric_value: number | null; amount: number | null; created_at: string };
type AttRecord = { office_number: string; employee_number: string; year: number; month: number; created_at: string };
type UnitPrice = { office_id: string; effective_from: string; updated_at: string };
type OfficeRow = { id: string; office_number: string };
type SoukatsuRow = { processing_month: string; office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };

async function main() {
  const [calc, inputs, forms, atts, prices, offices, soukatsu] = await Promise.all([
    getAll<CalcRow>("payroll_calc_results?select=office_number,processing_month,calculated_at"),
    getAll<MonthlyInput>("payroll_monthly_inputs?select=office_number,employee_number,processing_month,item_key,numeric_value,updated_at"),
    getAll<FormRecord>("payroll_office_form_records?select=office_number,employee_number,processing_month,item_name,numeric_value,amount,created_at"),
    getAll<AttRecord>("payroll_attendance_records?select=office_number,employee_number,year,month,created_at"),
    getAll<UnitPrice>("payroll_office_unit_prices?select=office_id,effective_from,updated_at"),
    getAll<OfficeRow>("payroll_offices?select=id,office_number"),
    getAll<SoukatsuRow>("payroll_soukatsu_rows?select=processing_month,office_number,employee_number,sheet_kind,row_data"),
  ]);

  const officeIdToNumber = new Map(offices.map((o) => [o.id, o.office_number]));
  // 事業所番号ごとの単価行 (effective_from, updated_at)
  const pricesByOffice = new Map<string, UnitPrice[]>();
  for (const p of prices) {
    const on = officeIdToNumber.get(p.office_id);
    if (!on) continue;
    if (!pricesByOffice.has(on)) pricesByOffice.set(on, []);
    pricesByOffice.get(on)!.push(p);
  }

  // 残業単価の参照用 (総括表 shaseki の 残業単価 列。無ければ影響額は不明のまま出す)
  const rateByEmpMonth = new Map<string, number>(); // office|emp|month -> 残業単価
  for (const s of soukatsu) {
    if (s.sheet_kind !== "shaseki") continue;
    const tanka = num(s.row_data["残業単価"]);
    if (tanka > 0) rateByEmpMonth.set(`${s.office_number}|${nn(s.employee_number)}|${s.processing_month}`, tanka);
  }

  const inputsByOfficeMonth = new Map<string, MonthlyInput[]>();
  for (const r of inputs) {
    const k = `${r.office_number}|${r.processing_month}`;
    if (!inputsByOfficeMonth.has(k)) inputsByOfficeMonth.set(k, []);
    inputsByOfficeMonth.get(k)!.push(r);
  }
  const formsByOfficeMonth = new Map<string, FormRecord[]>();
  for (const r of forms) {
    const k = `${r.office_number}|${r.processing_month}`;
    if (!formsByOfficeMonth.has(k)) formsByOfficeMonth.set(k, []);
    formsByOfficeMonth.get(k)!.push(r);
  }
  const attsByOfficeMonth = new Map<string, AttRecord[]>();
  for (const r of atts) {
    const pm = `${r.year}${String(r.month).padStart(2, "0")}`;
    const k = `${r.office_number}|${pm}`;
    if (!attsByOfficeMonth.has(k)) attsByOfficeMonth.set(k, []);
    attsByOfficeMonth.get(k)!.push(r);
  }

  const target = OFFICE_FILTER ? calc.filter((c) => c.office_number === OFFICE_FILTER) : calc;

  type StaleReason = { kind: string; count: number; latestTs: string; detail: string[] };
  type StaleRow = { office: string; month: string; calculatedAt: string; reasons: StaleReason[] };
  const stale: StaleRow[] = [];

  for (const c of target) {
    const k = `${c.office_number}|${c.processing_month}`;
    const reasons: StaleReason[] = [];

    // 1. monthly_inputs
    const mi = inputsByOfficeMonth.get(k) ?? [];
    const miNewer = mi.filter((r) => r.updated_at > c.calculated_at);
    if (miNewer.length) {
      const byKey = new Map<string, MonthlyInput[]>();
      for (const r of miNewer) {
        if (!byKey.has(r.item_key)) byKey.set(r.item_key, []);
        byKey.get(r.item_key)!.push(r);
      }
      for (const [itemKey, rows] of byKey) {
        const detail = rows.map((r) => {
          const empKey = `${c.office_number}|${nn(r.employee_number)}|${c.processing_month}`;
          const val = num(r.numeric_value);
          let est = "";
          if (itemKey === "overtime_minutes") {
            const rate = rateByEmpMonth.get(empKey);
            est = rate ? ` 見込み残業総額≈¥${Math.round((val / 60) * rate).toLocaleString()}` : " 単価不明のため見込み額なし";
          } else if (itemKey === "legal_within_overtime_minutes") {
            const rate = rateByEmpMonth.get(empKey);
            est = rate ? ` 見込み法内残業手当≈¥${Math.round((val / 60) * (rate / 1.25)).toLocaleString()}` : " 単価不明のため見込み額なし";
          } else if (itemKey === "commute_yen") {
            est = ` 直接加算見込み¥${val.toLocaleString()}`;
          }
          return `職員${nn(r.employee_number)} ${val}${est}`;
        });
        reasons.push({ kind: `monthly_inputs.${itemKey}`, count: rows.length, latestTs: rows.map((r) => r.updated_at).sort().at(-1)!, detail });
      }
    }

    // 2. office_form_records
    const fr = formsByOfficeMonth.get(k) ?? [];
    const frNewer = fr.filter((r) => r.created_at > c.calculated_at);
    if (frNewer.length) {
      const byItem = new Map<string, FormRecord[]>();
      for (const r of frNewer) {
        if (!byItem.has(r.item_name)) byItem.set(r.item_name, []);
        byItem.get(r.item_name)!.push(r);
      }
      for (const [itemName, rows] of byItem) {
        reasons.push({
          kind: `office_form_records.${itemName}`,
          count: rows.length,
          latestTs: rows.map((r) => r.created_at).sort().at(-1)!,
          detail: [`${rows.length}行 (見込み額は書式・項目ごとに計算式が異なるため未算出。要再計算)`],
        });
      }
    }

    // 3. attendance_records
    const ar = attsByOfficeMonth.get(k) ?? [];
    const arNewer = ar.filter((r) => r.created_at > c.calculated_at);
    if (arNewer.length) {
      const empSet = new Set(arNewer.map((r) => nn(r.employee_number)));
      reasons.push({
        kind: "attendance_records",
        count: arNewer.length,
        latestTs: arNewer.map((r) => r.created_at).sort().at(-1)!,
        detail: [`${empSet.size}名ぶん・${arNewer.length}行 (出勤簿由来の残業・欠勤控除等が未反映の可能性。見込み額は出勤簿の再計算が要るため未算出)`],
      });
    }

    // 4. office_unit_prices (事業所単位。その処理月の月末までに effective になっている単価行のみ対象)
    const endIso = monthEndIso(c.processing_month);
    const applicablePrices = (pricesByOffice.get(c.office_number) ?? []).filter((p) => p.effective_from <= endIso);
    const priceNewer = applicablePrices.filter((p) => p.updated_at > c.calculated_at);
    if (priceNewer.length) {
      reasons.push({
        kind: "office_unit_prices",
        count: priceNewer.length,
        latestTs: priceNewer.map((p) => p.updated_at).sort().at(-1)!,
        detail: priceNewer.map((p) => `effective_from=${p.effective_from} (単価改定。移動費・通勤費等 事業所全員に影響。見込み額は再計算が要るため未算出)`),
      });
    }

    if (reasons.length) stale.push({ office: c.office_number, month: c.processing_month, calculatedAt: c.calculated_at, reasons });
  }

  // ── 負のコントロール: 実データを1件だけ「計算日を1970年に巻き戻したコピー」にして
  //    同じ判定ロジックを通し、必ず stale として検知されることを確認する (DB書換なし・メモリ内のみ) ──
  let negControlOk = false;
  if (target.length > 0) {
    const sample = target[0];
    const fakeOldCalc = { ...sample, calculated_at: "1970-01-01T00:00:00Z" };
    const k = `${fakeOldCalc.office_number}|${fakeOldCalc.processing_month}`;
    const hasAnyInput =
      (inputsByOfficeMonth.get(k)?.length ?? 0) > 0 ||
      (formsByOfficeMonth.get(k)?.length ?? 0) > 0 ||
      (attsByOfficeMonth.get(k)?.length ?? 0) > 0 ||
      (pricesByOffice.get(fakeOldCalc.office_number)?.some((p) => p.effective_from <= monthEndIso(fakeOldCalc.processing_month)) ?? false);
    // 1970年より新しい入力が1件でもあれば stale 判定になるはず (実データはほぼ確実に該当する)
    negControlOk = hasAnyInput;
  }

  console.log("=== payroll_calc_results の古さ検査 (2026-09-26 新設・読み取り専用) ===");
  console.log("");
  console.log("★ このスナップショットが古いまま再計算していないと:");
  console.log("  ・入っているはずの手入力(残業・通勤費等)が反映されず「計算がおかしい」と誤診する");
  console.log("  ・実際は「バグ」ではなく「まだ再計算していないだけ」のケースを見分けられない");
  console.log("  ・単価改定(2025-04等)が過去の月の再計算に反映されているかも判定できない");
  console.log("  (実例: 給与E がおゆみ野4名の乖離を「バグでなくスナップショットが古いだけ」と特定した)");
  console.log("");
  console.log(`負のコントロール(計算日を1970年に巻き戻して検知できるか): ${negControlOk ? "OK (検知できた)" : "★ NG (検知ロジックが壊れている疑い)"}`);
  console.log("");
  console.log(`calc_results 対象 ${target.length} 件中、古い(=その後に新しい入力がある) ${stale.length} 件`);
  const onlyPriceReason = stale.filter((s) => s.reasons.every((r) => r.kind === "office_unit_prices")).length;
  const employeeLevelReason = stale.length - onlyPriceReason;
  console.log(`  うち office_unit_prices(事業所単価の履歴化。2026-09-26の一斉移行が原因で全事業所が該当)だけが理由: ${onlyPriceReason} 件`);
  console.log(`  うち 職員単位の入力(monthly_inputs / office_form_records / attendance_records)も理由に含む: ${employeeLevelReason} 件 ← ★ここが今すぐ再計算すべき対象`);
  console.log("");

  const kindTotals = new Map<string, number>();
  for (const s of stale) for (const r of s.reasons) kindTotals.set(r.kind, (kindTotals.get(r.kind) ?? 0) + r.count);
  console.log("--- 入力の種類ごとの内訳 (件数は行数。人月ではない場合あり) ---");
  for (const [k, v] of [...kindTotals.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log("");

  console.log("--- 事業所×月ごとの詳細 ---");
  for (const s of stale.sort((a, b) => (a.office + a.month).localeCompare(b.office + b.month))) {
    console.log(`\n[${s.office} / ${s.month}]  計算日時=${s.calculatedAt}`);
    for (const r of s.reasons) {
      console.log(`  ${r.kind} (${r.count}件, 最新=${r.latestTs})`);
      for (const d of r.detail.slice(0, 10)) console.log(`    - ${d}`);
      if (r.detail.length > 10) console.log(`    ...他 ${r.detail.length - 10} 件`);
    }
  }

  if (stale.length === 0) console.log("\n古いものはありません。");
}

main().catch((e) => {
  console.error("check-calc-staleness failed:", e);
  process.exit(1);
});
