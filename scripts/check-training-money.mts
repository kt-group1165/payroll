/**
 * 研修・会議を「実際に払った額どうし」で総括表と突合する (2026-09-26)。読み取りのみ・DB書換なし。
 *
 *   npx tsx scripts/check-training-money.mts                       # 全事業所・全月 (重い。常用しない)
 *   OFFICE=1270303173 MONTH=202608 npx tsx scripts/check-training-money.mts   # ★ 普段はこちら
 *
 * 当方  : payroll_calc_results.payload.hourly の training_pay − shoninsha_pay + meeting_fee
 *         (★ 初任者研修費は 総括表では「本人給」に入るので引く)
 * 総括表: row_data の「その他手当」(= HRD研修(円) + 会議費。事業所によって会議を 会議費列でなく その他手当に直接入れる)
 *
 * ★ なぜ金額で比べるか: 総括表の研修系の列は「区分の合計」で、当方の項目と 1 対 1 ではない。
 *   内研修時間 = HRD研修 + 研修 (+ 会議)。分や項目で比べると 区分の違いがそのまま「不一致」に化ける
 *   (2026-09-26 に 研修 48 件 ¥88,552 の偽陽性を出し、原本 (事業所書式CSV) で撤回した)。
 *   → 金額どうしで突合してから項目に降りる。
 * ⚠ payload が入力 (事業所書式・手入力) より古い事業所月は比べない (calculated_at と created_at を比較)。
 * ⚠ payload がコードや設定の変更より古い場合は検知できない (例: 会議単価の設定が計算後に入った)。
 *   不一致が出たら まず再計算してから見ること。
 */
import { restAll } from "./_rest.mjs";

const OFFICE = process.env.OFFICE;
const MONTH = process.env.MONTH;
const scope = [OFFICE ? `office_number=eq.${OFFICE}` : "", MONTH ? `processing_month=eq.${MONTH}` : ""].filter(Boolean).join("&");
const and = scope ? `&${scope}` : "";
const norm = (n: unknown) => String(n ?? "").replace(/^0+/, "");
const num = (v: unknown) => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const key = (o: string, e: string, m: string) => `${o}|${norm(e)}|${m}`;

type Sou = { office_number: string; employee_number: string; processing_month: string; oth: string | null; hrd: string | null; kai: string | null; ken: string | null };
type Calc = { office_number: string; processing_month: string; calculated_at: string; hourly: Record<string, unknown>[] | null };
type Stamp = { office_number: string; processing_month: string; created_at: string };

async function main() {
  // ★ row_data は全部読まず 使う 4 項目だけ取り出す (DB 負荷を下げる)
  const sou = await restAll<Sou>(`payroll_soukatsu_rows?select=office_number,employee_number,processing_month,oth:row_data->>その他手当,hrd:row_data->>HRD研修,kai:row_data->>会議費,ken:row_data->>内研修時間&sheet_kind=eq.part${and}`);
  const calc = await restAll<Calc>(`payroll_calc_results?select=office_number,processing_month,calculated_at,hourly:payload->hourly${and}`);
  const stamps = [
    ...await restAll<Stamp>(`payroll_office_form_records?select=office_number,processing_month,created_at&record_type=eq.training${and}`),
    ...await restAll<Stamp>(`payroll_monthly_inputs?select=office_number,processing_month,created_at&item_key=in.(training_minutes,shoninsha_training_minutes)${and}`),
  ];

  const latestInput = new Map<string, string>();
  for (const r of stamps) {
    const k = `${r.office_number}|${r.processing_month}`;
    if (!latestInput.has(k) || r.created_at > latestInput.get(k)!) latestInput.set(k, r.created_at);
  }
  const ours = new Map<string, { money: number; detail: string; calcAt: string; stale: boolean }>();
  for (const c of calc) {
    const stale = (latestInput.get(`${c.office_number}|${c.processing_month}`) ?? "") > c.calculated_at;
    for (const e of c.hourly ?? []) {
      const tp = num(e.training_pay) ?? 0, sh = num(e.shoninsha_pay) ?? 0, mf = num(e.meeting_fee) ?? 0;
      ours.set(key(c.office_number, String(e.employee_number), c.processing_month), {
        money: tp - sh + mf, detail: `研修${tp}(うち初任者${sh})+会議${mf}`, calcAt: c.calculated_at, stale,
      });
    }
  }

  let both = 0, match = 0, staleSkip = 0, under = 0, over = 0;
  const lines: string[] = [];
  for (const r of sou) {
    if (num(r.ken) == null && num(r.hrd) == null && num(r.kai) == null && num(r.oth) == null) continue;
    const o = ours.get(key(r.office_number, r.employee_number, r.processing_month));
    if (!o) continue;
    if (o.stale) { staleSkip++; continue; }
    both++;
    const sm = num(r.oth) ?? 0;
    if (Math.abs(o.money - sm) <= 1) { match++; continue; }
    const d = sm - o.money;
    if (d > 0) under += d; else over += -d;
    lines.push(`  ${key(r.office_number, r.employee_number, r.processing_month)}: 当方 ${o.detail}→${o.money} / 総括表 その他手当${sm} (HRD研修${num(r.hrd) ?? 0} 会議費${num(r.kai) ?? 0} 内研修時間${r.ken ?? "-"}) 差${d > 0 ? "+" : ""}${d} calc=${o.calcAt.slice(0, 16)}`);
  }
  console.log(`範囲: ${scope || "全事業所・全月"}`);
  console.log(`payload が入力より古く 比べなかった人月: ${staleSkip}`);
  console.log(`母数 (比べた人月): ${both}  一致: ${match}  不一致: ${lines.length}`);
  console.log(`  当方が少ない 計 ¥${under.toLocaleString()} / 当方が多い 計 ¥${over.toLocaleString()}`);
  lines.sort().forEach((l) => console.log(l));
}
main().catch((e) => { console.error(e); process.exit(1); });
