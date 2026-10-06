/**
 * check:office-price-revision — 事業所の単価・残業設定を変えたとき 改定月から効き、前の月は変わらないか (2026-10-06 新設)
 *
 *   npm run check:office-price-revision
 *
 * ★ DB は書かない。payroll_office_unit_prices を まねた 手元の表に対して
 *   本番と同じ recordOfficePriceRevision (書く側) と applyOfficeUnitPrices (給与計算が読む側) を通す。
 * ★ 見ているもの:
 *   ① 改定月より前の月は 今までの単価 / 改定月からは 新しい単価
 *   ② 履歴が null の単価 (同行キャンセル単価は列を足したとき null) を変えても 前の月が新しい単価にならない
 *   ③ 同じ改定月で 2 回保存したら 上書き (行が増えない)
 *   ④ もっと後の改定があれば laterFrom で知らせる
 * ★ 負のコントロール: ② の null 埋めを止めた版 (fillNulls=false) では ② が落ちることを確かめる
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyOfficeUnitPrices, type OfficeUnitPriceRow } from "../src/lib/payroll/office-price-history.js";
import { priceValuesOf, recordOfficePriceRevision, type OfficePriceValues } from "../src/lib/payroll/office-price-revision.js";
import { activeOvertimeRow, buildActiveOvertimeMap } from "../src/lib/payroll/overtime-settings-history.js";

type Row = OfficeUnitPriceRow & { id: string; note?: string; updated_at?: string };

/** payroll_office_unit_prices の 使う操作だけ まねた表 (select→eq→order / update→eq / upsert onConflict) */
function fakeDb(rows: Row[], opts: { fillNulls: boolean }) {
  let seq = 1000;
  const sb = {
    from() {
      return {
        select() {
          let officeId = "";
          const q = {
            eq(_c: string, v: string) { officeId = v; return q; },
            order() {
              return Promise.resolve({ data: rows.filter((r) => r.office_id === officeId).sort((a, b) => a.effective_from.localeCompare(b.effective_from)).map((r) => ({ ...r })), error: null });
            },
          };
          return q;
        },
        update(patch: Partial<Row>) {
          return {
            eq(_c: string, id: string) {
              if (opts.fillNulls) Object.assign(rows.find((r) => r.id === id)!, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
        upsert(rec: Row) {
          const ex = rows.find((r) => r.office_id === rec.office_id && r.effective_from === rec.effective_from);
          if (ex) Object.assign(ex, rec); else rows.push({ ...rec, id: String(seq++) });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return sb as unknown as SupabaseClient;
}

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const OFFICE = "office-1";
/** 本番の初期投入と同じ形: 1970-01-01 の行 + 同行キャンセルだけ null (列を後から足したため) */
const seed = (): Row[] => [{
  id: "1", office_id: OFFICE, effective_from: "1970-01-01",
  travel_unit_price: 12.6, commute_unit_price: 12.6, treatment_subsidy_amount: 20000, cancel_unit_price: 800,
  doukou_cancel_unit_price: null, travel_allowance_rate: 1200, communication_fee_amount: 0, meeting_unit_price: 1500, distance_adjustment_rate: 100,
}];
/** payroll_offices (今の値) */
const current = { id: OFFICE, travel_unit_price: 12.6, commute_unit_price: 12.6, treatment_subsidy_amount: 20000, cancel_unit_price: 800, doukou_cancel_unit_price: 600, travel_allowance_rate: 1200, communication_fee_amount: 0, meeting_unit_price: 1500, distance_adjustment_rate: 100 };

/** 給与計算が その月に使う単価 (payroll_offices の今の値 + 履歴) */
const priceAt = (rows: Row[], cur: typeof current, month: string) =>
  applyOfficeUnitPrices([cur], rows, `${month}-01`).offices[0];

async function scenario(fillNulls: boolean) {
  const rows = seed();
  const sb = fakeDb(rows, { fillNulls });
  const before: OfficePriceValues = priceValuesOf(current);
  const after: OfficePriceValues = { ...before, travel_unit_price: 13, doukou_cancel_unit_price: 650 };
  const r1 = await recordOfficePriceRevision(sb, OFFICE, before, after, "2026-11-01", "test");
  // 画面は保存後 payroll_offices も新しい値にする
  const cur2 = { ...current, ...after };
  return { rows, r1, cur2, sb, before, after };
}

const main = async () => {
  const { rows, r1, cur2, sb, after } = await scenario(true);
  eq("① 10月分は 今までの出張単価 12.6", priceAt(rows, cur2, "2026-10").travel_unit_price, 12.6);
  eq("① 11月分から 新しい出張単価 13", priceAt(rows, cur2, "2026-11").travel_unit_price, 13);
  eq("② 10月分の同行キャンセルは 600 のまま (履歴 null を 600 で埋めた)", priceAt(rows, cur2, "2026-10").doukou_cancel_unit_price, 600);
  eq("② 11月分から 同行キャンセル 650", priceAt(rows, cur2, "2026-11").doukou_cancel_unit_price, 650);
  eq("④ 後の改定なし", r1.laterFrom, []);

  const after2 = { ...after, travel_unit_price: 13.5 };
  await recordOfficePriceRevision(sb, OFFICE, after, after2, "2026-11-01", "test");
  eq("③ 同じ改定月で 2 回保存 → 行は 2 行のまま (上書き)", rows.length, 2);
  eq("③ 上書き後の 11月分 出張単価 13.5", priceAt(rows, { ...cur2, ...after2 }, "2026-11").travel_unit_price, 13.5);

  const r3 = await recordOfficePriceRevision(sb, OFFICE, after2, { ...after2, cancel_unit_price: 900 }, "2026-09-01", "test");
  eq("④ 11月の改定がある状態で 9月から改定 → laterFrom に 2026-11-01", r3.laterFrom, ["2026-11-01"]);
  eq("④ 9月分は キャンセル 900", priceAt(rows, { ...cur2, ...after2 }, "2026-09").cancel_unit_price, 900);
  eq("④ 9月分の 出張単価は 9月に効いていた 12.6 のまま (後の改定の 13.5 を持ち込まない)", priceAt(rows, { ...cur2, ...after2 }, "2026-09").travel_unit_price, 12.6);
  eq("④ 9月分の 同行キャンセルも 600 のまま", priceAt(rows, { ...cur2, ...after2 }, "2026-09").doukou_cancel_unit_price, 600);
  eq("④ 11月分は 11月の改定 (キャンセル 800) のまま", priceAt(rows, { ...cur2, ...after2 }, "2026-11").cancel_unit_price, 800);

  const unchanged = await recordOfficePriceRevision(sb, OFFICE, after2, after2, "2026-12-01", "test");
  eq("変えていなければ 何も書かない", [unchanged.laterFrom, rows.length], [[], 3]);

  // 残業設定の履歴 (2026-10-06): 改定月より前は旧設定・後は新設定。job_type だけの Map (旧実装) だと 後の行が常に勝つ
  const ot = [
    { job_type: "訪問介護", effective_from: "1970-01-01", scheduled_hours_per_month: 168 },
    { job_type: "訪問介護", effective_from: "2026-11-01", scheduled_hours_per_month: 160 },
    { job_type: "本社", effective_from: "1970-01-01", scheduled_hours_per_month: 160 },
  ];
  eq("残業設定: 10月分は 168h のまま", buildActiveOvertimeMap(ot, "2026-10-01").get("訪問介護")?.scheduled_hours_per_month, 168);
  eq("残業設定: 11月分から 160h", buildActiveOvertimeMap(ot, "2026-11-01").get("訪問介護")?.scheduled_hours_per_month, 160);
  eq("残業設定: 改定の無い職種は初期値", activeOvertimeRow(ot, "本社", "2026-12-01")?.scheduled_hours_per_month, 160);
  const oldStyle = new Map(ot.map((r) => [r.job_type, r]));
  const negOt = oldStyle.get("訪問介護")?.scheduled_hours_per_month === 160;
  if (negOt) pass++; else fail++;
  console.log(`${negOt ? "✓" : "✗"} 負のコントロール: job_type だけの Map だと 10月分も 160h になる (= 旧実装の誤りを検査が捉える)`);

  // 負のコントロール: null 埋めをしない版では ② が落ちる (10月分が新しい 650 になってしまう)
  const neg = await scenario(false);
  const negVal = priceAt(neg.rows, neg.cur2, "2026-10").doukou_cancel_unit_price;
  const negOk = negVal === 650;
  if (negOk) pass++; else fail++;
  console.log(`${negOk ? "✓" : "✗"} 負のコントロール: null を埋めないと 10月分が 650 に変わる (= 検査が効いている) got=${negVal}`);

  console.log(`\n合格 ${pass} / ${pass + fail}`);
  if (fail > 0) process.exit(1);
};
main().catch((e) => { console.error(e); process.exit(1); });
