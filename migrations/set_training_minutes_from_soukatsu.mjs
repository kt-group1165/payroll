/**
 * 事業所書式に無い 研修・会議の時間を 月ごとの手入力に入れる (2026-09-23)。
 *
 *   SP=<scratchpad> node migrations/set_training_minutes_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/set_training_minutes_from_soukatsu.mjs --execute
 *
 * 会議・研修は 本稼働後は 事業所書式が唯一の元 (user 2026-09-23「本稼働後は事業所書式だよ。もちろん」)。
 * 検証中の 3〜8月だけ、総括表①(旧システムの出力) にあって書式に無い分を 手入力で補う。
 *
 * パート・社員/提責の両方が対象 (社員・提責は HRD が 介護超過の時間にも効く)。
 * 対象: ①の HRD研修時間 / 研修時間 / 会議時間 / 初任者研修時間 の合計 > 0 で、
 *       当システムの事業所書式から その月の研修・会議の時間が 0 分の人
 *       (レコードが無い / あっても時刻が空・終了0:00 などで時間が取れない。五井 柴山・東郷 酒井/太野)。
 * 入れるのは「時間 (分)」。金額は 1,150 円/時 で給与計算が出す。
 * 書式に一部でもあるなら触らない (二重になるため)。冪等。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<layer1_all.json のある作業フォルダ> を指定"); process.exit(1); }
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
};
const OFF = { "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116", "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546", "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967", "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829", "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366", "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561", "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518" };
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const mins = (v) => {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return 0;
  if (s.includes(":")) { const [h, m] = s.split(":"); return (Number(h) || 0) * 60 + (Number(m) || 0); }
  const f = parseFloat(s);
  return isNaN(f) ? 0 : Math.round(f * 60);
};

const L1 = JSON.parse(readFileSync(`${SP}/layer1_all.json`, "utf8"));
// 社員・提責の HRD は ①(旧システム) に無く ②(総括表の提責_社員シート) に手入力されている。②からも拾う
const L2 = new Map();
for (const M of ["202603", "202604", "202605", "202606", "202607"]) {
  let rows = [];
  try { rows = JSON.parse(readFileSync(`${SP}/soukatsu${M}/extract.json`, "utf8")); } catch { continue; }
  for (const f of rows) {
    if (f.kind === "part") continue;
    for (const r of f.rows) {
      const code = nn(r._code);
      if (!code || String(r._code).includes("合計")) continue;
      const v = Number(r["HRD"] ?? 0);           // ② のHRDは「分」
      if (v > 0) L2.set(`${M}|${f.office}|${code}`, v);
    }
  }
}
const MONTHS = ["202603", "202604", "202605", "202606", "202607"];
const ops = [], skipped = [];
for (const M of MONTHS) {
  const of = await get(`payroll_office_form_records?select=office_number,employee_number,item_name,start_time,end_time,break_time&processing_month=eq.${M}&record_type=eq.training`);
  // 書式から取れる時間 (分)。時刻が空・終了0:00 などで 0 分なら「書式に無い」と同じ扱い
  const formMin = new Map();
  for (const r of of) {
    const k = r.office_number + "|" + nn(r.employee_number);
    const st = mins(r.start_time), en = mins(r.end_time);
    const v = st > 0 && en > st ? en - st - mins(r.break_time) : 0;
    formMin.set(k, (formMin.get(k) ?? 0) + Math.max(0, v));
  }
  const exist = await get(`payroll_monthly_inputs?select=office_number,employee_number,numeric_value&processing_month=eq.${M}&item_key=eq.training_minutes`);
  const already = new Map(exist.map((r) => [r.office_number + "|" + nn(r.employee_number), Number(r.numeric_value ?? 0)]));
  for (const [key, a] of Object.entries(L1)) {
    const [m, office, kind, code] = key.split("|");
    if (m !== M) continue;
    const on = OFF[office];
    if (!on) continue;
    const fromL1 = mins(a["HRD研修時間"]) + mins(a["研修時間"]) + mins(a["会議時間"]) + mins(a["初任者研修時間"]);
    // 社員・提責は ② の HRD (分) も見る (①に無く ②に手入力されている)
    const total = kind === "part" ? fromL1 : Math.max(fromL1, L2.get(`${M}|${office}|${code}`) ?? 0);
    if (total <= 0) continue;
    const k = on + "|" + code;
    if ((formMin.get(k) ?? 0) > 0) continue;            // 書式から時間が取れるなら触らない
    if (already.get(k) === total) continue;             // 冪等
    ops.push({ office_number: on, employee_number: code, processing_month: M, item_key: "training_minutes", numeric_value: total,
      note: `総括表① の 研修・会議の時間より (事業所書式に記録が無いため。本稼働後は書式に入れる) 2026-09-23`,
      label: `${office} ${M} ${a["氏名"]}: ${total}分 (HRD ${a["HRD研修時間"] || "-"} / 研修 ${a["研修時間"] || "-"} / 会議 ${a["会議時間"] || "-"} / 初任者 ${a["初任者研修時間"] || "-"})` });
  }
}
console.log(`=== 研修・会議の時間の手入力 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
