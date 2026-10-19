/**
 * ケアマネの出勤簿 (Excel) から抜いた日ごとの行を 居宅の出勤簿 (payroll_kyotaku_attendance_records) に入れる (2026-10-19)。
 *
 *   python -I migrations/_parse_cm_attendance_books.py <コピーした M 月フォルダ> > cm_days.json   (抜き出し。説明はそちら)
 *   npx tsx migrations/import_kyotaku_attendance_from_cm_books.mts cm_days.json 2026-06            # DRY RUN
 *   npx tsx migrations/import_kyotaku_attendance_from_cm_books.mts cm_days.json 2026-06 --execute [--skip-unknown]
 *
 * なぜ: 居宅の給与の 通勤費・出張費は 出勤簿の km から出すが、居宅の出勤簿は DB にほぼ無かった
 *   (2026-06/07 で 9 人・2 事業所・通勤 km 0 件)。総括表 (ケアマネ) の距離は この出勤簿の移動距離の合計と同じ。
 *
 * 入れ方:
 *   ・事業所 = 出勤簿のフォルダ (拠点) / 職員 = その事業所の職員一覧の氏名 (空白・字体 (邊/邉/齊/齋/髙/﨑) を寄せて比べる)
 *   ・移動距離は 総括表と同じ欄に入れる: いすみ・大網・茂原 = 出張距離 (business_km) / それ以外 = 通勤距離 (commute_km)
 *     (総括表は いすみを全部 出張費、大網・茂原は「出張距離」の欄で持つ。通勤費の上限を超えた分は 計算で出張費に回る)
 *   ・休憩 = (退社 − 出社) − 就業時間。就業時間が無い・合わないときは 6 時間を超える日だけ 60 分
 *   ・有給 = 備考に「有給」。「午前」「午後」「半」を含めば 半日
 *   ・時刻も距離も無く 有給でもない日 (公休など) は 入れない
 *   ・★ 同じ職員・同じ日の行が既にあれば 上書きしない (飛ばして数を出す)。入れた行の id は 退避ファイルに残す (消すとき用。commit しない)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const [SRC, MONTH] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC || !existsSync(SRC) || !/^\d{4}-\d{2}$/.test(MONTH ?? "")) {
  console.error("使い方: import_kyotaku_attendance_from_cm_books.mts <cm_days.json> <YYYY-MM> [--execute]");
  process.exit(1);
}
type Rec = { start: number | null; end: number | null; hours: number | null; km: number | null; note: string | null };
const parsed = JSON.parse(readFileSync(SRC, "utf8")) as { days: Record<string, { rec: Rec; file: string; sheet: string }>; conflicts: unknown[] };

/** 出勤簿のフォルダ名 → 居宅の事業所番号 */
const AREA: Record<string, string> = {
  KT姉崎: "1272401876", いすみ: "1278600406", おゆみ: "1270501172", 五井: "1272400506", 花見川: "1270201922", 袖ヶ浦: "1273400851",
  ちはら: "1272403492", 八千代: "1272603844", 四街道: "1270303272", 大網: "1279200081", 姉ムツ: "1272400837", 木更津: "1271101287",
  船橋: "1270907411", 茂原: "1271500934", 高品: "1270404229",
};
/** 移動距離を 出張距離で持つ事業所 (総括表どおり) */
const BUSINESS_KM_OFFICES = new Set(["1278600406", "1279200081", "1271500934"]);
const VARIANT: Record<string, string> = { 邊: "辺", 邉: "辺", 齊: "斉", 齋: "斉", 斎: "斉", 髙: "高", 﨑: "崎" };
const ALIAS: Record<string, string> = { 坂本佑香: "坂本祐香" };
const nm = (s: string) => { const t = [...s.normalize("NFKC").replace(/[\s　]/g, "")].map((c) => VARIANT[c] ?? c).join(""); return ALIAS[t] ?? t; };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const offices = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number&office_type=eq.居宅介護支援");
const officeId = new Map(offices.map((o) => [o.office_number, o.id]));
const emps = await restAll<{ id: string; name: string; office_id: string }>("payroll_employees?select=id,name,office_id");
const [y, m] = MONTH.split("-").map(Number);
const mStart = `${MONTH}-01`, mEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const existing = await restAll<{ employee_id: string; work_date: string }>(
  `payroll_kyotaku_attendance_records?select=id,employee_id,work_date&work_date=gte.${mStart}&work_date=lte.${mEnd}`);
const existingKey = new Set(existing.map((e) => `${e.employee_id}|${e.work_date}`));

const rows: Record<string, unknown>[] = [];
const noOffice = new Set<string>(), noEmp = new Set<string>();
let skipExisting = 0, skipEmpty = 0;
const perPerson = new Map<string, { days: number; km: number; leave: number }>();
for (const [key, v] of Object.entries(parsed.days)) {
  const [area, name, day] = key.split("|");
  if (!day.startsWith(MONTH)) continue;
  const on = AREA[area];
  if (!on || !officeId.has(on)) { noOffice.add(area); continue; }
  const emp = emps.filter((e) => e.office_id === officeId.get(on) && nm(e.name) === nm(name));
  if (emp.length !== 1) { noEmp.add(`${area} ${name}${emp.length > 1 ? " (同名が複数)" : ""}`); continue; }
  const r = v.rec;
  const leave = r.note && r.note.includes("有給") ? (/午前|午後|半/.test(r.note) ? "half" : "full") : null;
  if (r.start == null && r.km == null && !leave) { skipEmpty++; continue; }
  if (existingKey.has(`${emp[0].id}|${day}`)) { skipExisting++; continue; }
  const span = r.start != null && r.end != null ? r.end - r.start : null;
  const brk = span == null ? 0 : r.hours != null && r.hours * 60 <= span ? span - Math.round(r.hours * 60) : span > 360 ? 60 : 0;
  const km = r.km != null && r.km > 0 ? Math.round(r.km * 10) / 10 : null;
  rows.push({
    tenant_id: "kt-group", office_id: officeId.get(on), employee_id: emp[0].id, work_date: day,
    start_time: r.start != null ? hhmm(r.start) : null, end_time: r.end != null ? hhmm(r.end) : null, break_minutes: brk,
    is_legal_holiday: false, is_paid_leave: !!leave, paid_leave_type: leave, note: r.note,
    commute_km: BUSINESS_KM_OFFICES.has(on) ? null : km, business_km: BUSINESS_KM_OFFICES.has(on) ? km : null,
  });
  const p = perPerson.get(`${area} ${name}`) ?? { days: 0, km: 0, leave: 0 };
  p.days++; p.km += km ?? 0; if (leave) p.leave++;
  perPerson.set(`${area} ${name}`, p);
}

console.log(`${MONTH}: 入れる ${rows.length} 行 (${perPerson.size} 人) / 既に行がある日 ${skipExisting} (上書きしない) / 時刻も距離も無い日 ${skipEmpty}`);
console.log(`  事業所が分からないフォルダ ${noOffice.size}: ${[...noOffice].join(" / ")}`);
console.log(`  職員が引けない ${noEmp.size}: ${[...noEmp].join(" / ")}`);
console.log(`  抜き出しで 同じ日の値が別シートで違った ${parsed.conflicts.length} 件 (距離が入っている方 → 無ければ先に読んだシート)`);
for (const [k, p] of [...perPerson].sort().slice(0, 200)) console.log(`    ${k}: ${p.days} 日 / ${Math.round(p.km * 10) / 10} km / 有給 ${p.leave}`);
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }
// 職員が引けない人がいれば止める。--skip-unknown のときだけ その人を飛ばして入れる
if (noEmp.size && !process.argv.includes("--skip-unknown")) { console.error("✗ 職員が引けない人がいるので 書きません (職員一覧に登録するか --skip-unknown)"); process.exit(2); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const mm = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (mm && !env[mm[1]]) env[mm[1]] = mm[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
const ids: string[] = [];
for (let i = 0; i < rows.length; i += 500) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_kyotaku_attendance_records`, { method: "POST", headers: H, body: JSON.stringify(rows.slice(i, i + 500)) });
  if (!res.ok) { console.error(`✗ ${i} 行目から: ${res.status} ${(await res.text()).slice(0, 300)}`); break; }
  ids.push(...((await res.json()) as { id: string }[]).map((x) => x.id));
}
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const backup = `migrations/_backup_kyotaku_attendance_from_cm_books_${MONTH}_${stamp}.json`;
writeFileSync(backup, JSON.stringify({ month: MONTH, inserted_ids: ids }));
console.log(`書き込み ${ids.length} / ${rows.length} 行。入れた行の id → ${backup}`);
const after = await restAll<{ id: string }>(`payroll_kyotaku_attendance_records?select=id&work_date=gte.${mStart}&work_date=lte.${mEnd}`);
console.log(`確認: ${MONTH} の行 ${after.length} (前 ${existing.length} + 入れた ${ids.length} = ${existing.length + ids.length})`);
if (ids.length !== rows.length || after.length !== existing.length + ids.length) process.exit(1);
