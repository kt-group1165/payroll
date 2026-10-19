/**
 * ケアマネの出勤簿の下の欄 (予防件数・認定調査) を 居宅の給与の入力に入れる (2026-10-19)。
 *   予防件数 → payroll_kyotaku_yobou_records (source 'manual'・notes に出どころ)
 *   認定調査 → payroll_monthly_inputs (item_key kyotaku_survey_count)
 *
 *   python -I migrations/_parse_cm_attendance_books.py <コピーした M 月フォルダ> > cm_days.json   (抜き出し。monthly に入る)
 *   npx tsx migrations/import_kyotaku_yobou_survey_from_cm_books.mts cm_days.json 2026-06            # DRY RUN
 *   npx tsx migrations/import_kyotaku_yobou_survey_from_cm_books.mts cm_days.json 2026-06 --execute
 *
 * なぜ: user 2026-10-19「支援だけは取り込めない可能性が高いので システム上で入力できる方法を作って」→ 入力画面は作った (予防件数タブ)。
 *   過去の月は ケアマネ本人が出勤簿の下に書いた数字がある (総括表もこれを写している)。
 *   総括表と一致: 予防 6月 87/89・7月 87/89・8月 86/89・9月 92/93 / 調査 89/89・89/89・87/89・93/93 (出勤簿がある人)
 *
 * 入れ方:
 *   ・予防件数: 要支援 1・2 の内訳は出勤簿に無いので 合計を yobou1_count に入れる (単価は同じなので 給与は変わらない)。
 *     請求月 = 提供月の翌月 (「14+2(月遅れ)」のような書き方も 足して その月の分とする = 月遅れの調整が無かったもの として。user 2026-10-19 の突合の決まり)
 *   ・★ 予防件数が 50 件を超える・認定調査が 10 件を超える人月は 入れずに出す (打ち間違い。熊田美智代 2026-06 は「111」で 総括表は 11 = 30 万円の過払いになる)
 *   ・0 件は入れない。★ その事業所 × 提供月 × ケアマネ の予防の行が既にあれば 上書きしない (飛ばす)
 *   ・認定調査: 同じ (事業所, 職員番号, 月) の手入力が既にあれば 上書きしない
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const [SRC, MONTH] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC || !existsSync(SRC) || !/^\d{4}-\d{2}$/.test(MONTH ?? "")) {
  console.error("使い方: import_kyotaku_yobou_survey_from_cm_books.mts <cm_days.json> <YYYY-MM> [--execute]");
  process.exit(1);
}
type Monthly = { kaigo?: number | null; yobou?: number | null; survey?: number | null; sheet: string; file: string };
const parsed = JSON.parse(readFileSync(SRC, "utf8")) as { monthly?: Record<string, Monthly> };
if (!parsed.monthly) { console.error("monthly がありません (抜き出しを新しい _parse_cm_attendance_books.py で やり直す)"); process.exit(1); }

const AREA: Record<string, string> = {
  KT姉崎: "1272401876", いすみ: "1278600406", おゆみ: "1270501172", 五井: "1272400506", 花見川: "1270201922", 袖ヶ浦: "1273400851",
  ちはら: "1272403492", 八千代: "1272603844", 四街道: "1270303272", 大網: "1279200081", 姉ムツ: "1272400837", 木更津: "1271101287",
  船橋: "1270907411", 茂原: "1271500934", 高品: "1270404229",
};
const VARIANT: Record<string, string> = { 邊: "辺", 邉: "辺", 齊: "斉", 齋: "斉", 斎: "斉", 髙: "高", 﨑: "崎" };
const ALIAS: Record<string, string> = { 坂本佑香: "坂本祐香" };
const nm = (s: string) => { const t = [...s.normalize("NFKC").replace(/[\s　]/g, "")].map((c) => VARIANT[c] ?? c).join(""); return ALIAS[t] ?? t; };

const offices = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number&office_type=eq.居宅介護支援");
const officeId = new Map(offices.map((o) => [o.office_number, o.id]));
const emps = await restAll<{ id: string; name: string; employee_number: string; office_id: string }>("payroll_employees?select=id,name,employee_number,office_id");
const sm = `${MONTH}-01`;
const [y, m] = MONTH.split("-").map(Number);
const bm = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
const ym6 = MONTH.replace("-", "");
const yobouNow = await restAll<{ office_number: string; staff_name: string }>(`payroll_kyotaku_yobou_records?select=id,office_number,staff_name&service_month=eq.${sm}`);
const surveyNow = await restAll<{ office_number: string; employee_number: string }>(
  `payroll_monthly_inputs?select=office_number,employee_number&processing_month=eq.${ym6}&item_key=eq.kyotaku_survey_count`, "office_number");

const yobouRows: Record<string, unknown>[] = [], surveyRows: Record<string, unknown>[] = [];
const noEmp: string[] = [], odd: string[] = []; let skipY = 0, skipS = 0;
const YOBOU_MAX = 50, SURVEY_MAX = 10;
for (const [key, v] of Object.entries(parsed.monthly)) {
  const [area, name, mon] = key.split("|");
  if (mon !== MONTH) continue;
  const on = AREA[area];
  const emp = on ? emps.filter((e) => e.office_id === officeId.get(on) && nm(e.name) === nm(name)) : [];
  if (!on || emp.length !== 1) { noEmp.push(`${area} ${name}`); continue; }
  const e = emp[0];
  let yobou = Math.round(Number(v.yobou ?? 0)), survey = Math.round(Number(v.survey ?? 0));
  if (yobou > YOBOU_MAX) { odd.push(`${area} ${name} 予防 ${yobou} 件`); yobou = 0; }
  if (survey > SURVEY_MAX) { odd.push(`${area} ${name} 認定調査 ${survey} 件`); survey = 0; }
  if (yobou > 0) {
    if (yobouNow.some((r) => r.office_number === on && nm(r.staff_name) === nm(e.name))) skipY++;
    else yobouRows.push({ tenant_id: "kt-group", office_number: on, service_month: sm, billing_month: bm, staff_name: e.name, yobou1_count: yobou, yobou2_count: 0,
      source: "manual", source_filename: null, notes: `ケアマネの出勤簿から (${v.file} / ${v.sheet})。要支援1・2の内訳なし` });
  }
  if (survey > 0) {
    if (surveyNow.some((r) => r.office_number === on && r.employee_number === e.employee_number)) skipS++;
    else surveyRows.push({ office_number: on, employee_number: e.employee_number, processing_month: ym6, item_key: "kyotaku_survey_count", numeric_value: survey, updated_at: new Date().toISOString() });
  }
}
console.log(`${MONTH}: 予防件数 入れる ${yobouRows.length} 人 (計 ${yobouRows.reduce((a, r) => a + Number(r.yobou1_count), 0)} 件) / 既にある ${skipY}`);
console.log(`         認定調査 入れる ${surveyRows.length} 人 (計 ${surveyRows.reduce((a, r) => a + Number(r.numeric_value), 0)} 件) / 既にある ${skipS}`);
console.log(`  職員が引けない ${noEmp.length}: ${noEmp.join(" / ")}`);
console.log(`  ★ 多すぎるので入れない (出勤簿の打ち間違いの疑い。人が確かめて 画面で入れる) ${odd.length}: ${odd.join(" / ")}`);
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const mm = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (mm && !env[mm[1]]) env[mm[1]] = mm[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
const base = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const done: Record<string, string[]> = { yobou: [], survey: [] };
for (const [table, rows, k] of [["payroll_kyotaku_yobou_records", yobouRows, "yobou"], ["payroll_monthly_inputs", surveyRows, "survey"]] as const) {
  if (!rows.length) continue;
  const res = await fetch(`${base}/${table}`, { method: "POST", headers: H, body: JSON.stringify(rows) });
  if (!res.ok) { console.error(`✗ ${table}: ${res.status} ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const out = (await res.json()) as Record<string, unknown>[];
  done[k] = out.map((r) => String(r.id ?? `${r.office_number}|${r.employee_number}|${r.processing_month}|${r.item_key}`));
  if (out.length !== rows.length) { console.error(`✗ ${table}: ${out.length} / ${rows.length} 行`); process.exit(1); }
}
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const backup = `migrations/_backup_kyotaku_yobou_survey_from_cm_books_${MONTH}_${stamp}.json`;
writeFileSync(backup, JSON.stringify({ month: MONTH, ...done }));
console.log(`書き込み 予防 ${done.yobou.length} / 認定調査 ${done.survey.length}。入れた行 → ${backup}`);
