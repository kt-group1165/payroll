/**
 * check:setting-history-sync — 設定の「今の値」と「履歴のいちばん新しい値」が食い違っていないか (2026-10-06 新設・読み取り専用)
 *
 *   npm run check:setting-history-sync
 *
 * 給与計算は 対象月に有効な履歴の値で計算する (app-settings.ts readSettingRow / office-price-history.ts)。
 * ★ 今の値だけを書き換える経路 (migrations/set_*.mjs の古いスクリプト・SQL の直接 UPDATE) で変えると
 *   画面の表示は変わるのに 給与計算には効かない (履歴が勝つ)。黙って起きるので ここで見張る。
 *
 * 見るもの
 *   ① アプリ設定  payroll_app_settings.value  vs  payroll_app_setting_history の最新行の value (金額に効くキー)
 *   ② 事業所の単価 payroll_offices の単価列  vs  payroll_office_unit_prices の最新行 (null の列は 今の値を使うので見ない)
 * 食い違いが 1 件でもあれば FAIL。直し方: 画面から「何月分から」で入れ直す / 履歴に行を足す。
 * ★ 負のコントロール: 1 件目の値を手元で書き換えて 食い違いとして数えられることを確かめてから 合否を出す。
 */
import { restAll } from "./_rest.mjs";

type Setting = { key: string; value: unknown };
type Hist = { key: string; effective_from: string; value: unknown };
type Office = Record<string, unknown> & { id: string; office_number: string };
type Price = Record<string, unknown> & { office_id: string; effective_from: string };

const MONEY_KEYS = [
  "weekend_holiday_allowance_rates", "care_overtime_lower_tiers", "meeting_unit_prices", "meeting_fee_unpaid_offices",
  "meeting_count_items", "bath_care_modes", "care_075_offices", "sougou_seikatsu_rates", "doukou_engo_flat_rates",
  "juho_short_visit_rates", "overtime_excess_paid_employees", "commute_km_includes_trip_employees",
  "overtime_offset_full_care_offices", "office_worker_care_pay",
];
const PRICE_KEYS = [
  "travel_unit_price", "commute_unit_price", "treatment_subsidy_amount", "cancel_unit_price", "doukou_cancel_unit_price",
  "travel_allowance_rate", "communication_fee_amount", "meeting_unit_price", "distance_adjustment_rate", "work_week_start",
];

/** キーの並びに依存しない比較 (jsonb は並びが変わることがある) */
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
};

const [settings, hist, offices, prices] = await Promise.all([
  restAll<Setting>("payroll_app_settings?select=key,value&order=key"),
  restAll<Hist>("payroll_app_setting_history?select=key,effective_from,value&order=key,effective_from"),
  restAll<Office>(`payroll_offices?select=id,office_number,${PRICE_KEYS.join(",")}`),
  restAll<Price>(`payroll_office_unit_prices?select=office_id,effective_from,${PRICE_KEYS.join(",")}&order=office_id,effective_from`),
]);

function settingMismatches(cur: Setting[]): string[] {
  const latest = new Map<string, Hist>();
  for (const h of hist) { const c = latest.get(h.key); if (!c || h.effective_from > c.effective_from) latest.set(h.key, h); }
  const out: string[] = [];
  for (const s of cur) {
    if (!MONEY_KEYS.includes(s.key)) continue;
    const h = latest.get(s.key);
    if (!h) { out.push(`① ${s.key}: 履歴が 1 行も無い (給与計算は 今の値を使うが、改定の履歴が残らない)`); continue; }
    if (canon(h.value) !== canon(s.value)) out.push(`① ${s.key}: 今の値 と 履歴の最新 (${h.effective_from}〜) が違う`);
  }
  return out;
}

function priceMismatches(offs: Office[]): string[] {
  const latest = new Map<string, Price>();
  for (const p of prices) { const c = latest.get(p.office_id); if (!c || p.effective_from > c.effective_from) latest.set(p.office_id, p); }
  const out: string[] = [];
  for (const o of offs) {
    const p = latest.get(o.id);
    if (!p) continue;   // 履歴が無い事業所 = 今の値で計算 (給与計算が「単価の履歴なし」として出す)
    for (const k of PRICE_KEYS) {
      if (p[k] == null || o[k] == null) continue;
      if (Number(p[k]) !== Number(o[k])) out.push(`② ${o.office_number} ${k}: 今の値 ${o[k]} / 履歴の最新 (${p.effective_from}〜) ${p[k]}`);
    }
  }
  return out;
}

console.log("=== check:setting-history-sync (設定の今の値 vs 履歴の最新) ===");
console.log(`  アプリ設定 ${settings.length} 件 (うち金額に効く ${settings.filter((s) => MONEY_KEYS.includes(s.key)).length}) / 履歴 ${hist.length} 行`);
console.log(`  事業所 ${offices.length} / 単価の履歴 ${prices.length} 行`);

// 負のコントロール
const negS = settings.filter((s) => MONEY_KEYS.includes(s.key));
const negOk1 = negS.length === 0 || settingMismatches([{ ...negS[0], value: { __broken: true } }]).length === 1;
const negO = offices.find((o) => prices.some((p) => p.office_id === o.id && p.travel_unit_price != null));
const negOk2 = !negO || priceMismatches([{ ...negO, travel_unit_price: Number(negO.travel_unit_price) + 1 }]).length >= 1;
console.log(`  負のコントロール: アプリ設定 ${negOk1 ? "✓" : "✗"} / 事業所の単価 ${negOk2 ? "✓" : "✗"}`);

const bad = [...settingMismatches(settings), ...priceMismatches(offices)];
for (const b of bad) console.log(`  ✗ ${b}`);
if (!negOk1 || !negOk2) { console.log("\nFAIL — 負のコントロールが鳴らない (検査が効いていない)"); process.exit(1); }
if (bad.length > 0) { console.log(`\nFAIL — 食い違い ${bad.length} 件。画面から「何月分から」で入れ直すか 履歴に行を足す`); process.exit(1); }
console.log("\nPASS — 今の値と履歴の最新が すべて一致");
