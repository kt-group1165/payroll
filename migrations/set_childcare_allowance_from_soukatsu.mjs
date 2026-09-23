/**
 * 事業所書式に保育料が無い月の育児手当を 総括表② の額で補う (2026-09-23 user 了承)。
 *
 *   SP=<scratchpad> node migrations/set_childcare_allowance_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/set_childcare_allowance_from_soukatsu.mjs --execute
 *
 * 育児手当は 事業所書式の「保育料」(record_type=childcare) × 40% (幼稚園 20%) で出す。
 * 時給者は その月の訪問時間 / 120h で按分する。書式に行が無い月は **0 円**になる。
 * 3〜8月で 書式に行が無いのに ②(実際に払った額) には額がある人月が 18 件あった = **書式の記入漏れ**。
 * 出張km・研修と同じく、検証中だけ 月ごとの手入力で補う。本稼働後は書式に入れてもらう。
 *
 * ⚠ 保育料そのものではなく **支給額 (円)** を入れる (按分の元になる保育料が分からないため)。
 *   item_key = childcare_allowance。入っている月は 書式からの計算より優先される。
 * ⚠ 書式に行が **ある** 人月は **既定では触らない**。`INCLUDE_FORM_ROWS=1` を付けたときだけ
 *   ② との差が 100 円を超えるものを ② に合わせる (2026-09-23 user「記録だけしておいて」)。
 *   原因は 書式の金額が null / 「何月分」のずれ (茂原 渡邉美吹 は 2026/5 分が 5月と6月の両方に入っている) /
 *   ② が 0 円 (書式に保育料があるのに総括表は払っていない 3 件) など、**書式側のデータの問題**。
 * ⚠ 差 100 円以下 (31 件) は触らない。同じ保育料からの **按分の丸めの差**で、
 *   ここを上書きすると 当方の式のずれが見えなくなる。
 * 冪等: 既に同じ値なら触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<soukatsu*/extract.json のある作業フォルダ> を指定"); process.exit(1); }
const MONTHS = ["202603", "202604", "202605", "202606", "202607", "202608"];

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
const num = (v) => { const f = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(f) ? 0 : f; };

const form = await get("payroll_office_form_records?select=office_number,employee_number,processing_month&record_type=eq.childcare");
const hasForm = new Set(form.map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`));
// 当システムが今いくら出しているか (書式に行がある人月は 差が 100 円を超えるときだけ合わせる)
const calc = await get("payroll_calc_results?select=office_number,processing_month,payload");
const ours = new Map();
for (const c of calc) {
  for (const e of c.payload?.hourly ?? []) ours.set(`${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`, Number(e.childcare_allowance ?? 0));
  for (const e of c.payload?.monthly ?? []) ours.set(`${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`, Number(e.childcare_allowance ?? 0));
}
const ROUNDING = 100;
/** 書式に行がある月も ② に合わせるか。既定 false (調べただけで投入していない) */
const INCLUDE_FORM_ROWS = process.env.INCLUDE_FORM_ROWS === "1";
const exist = await get(`payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.childcare_allowance`);
const already = new Map(exist.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value ?? 0)]));

const ops = [], skipped = [];
for (const M of MONTHS) {
  let sheets = [];
  try { sheets = JSON.parse(readFileSync(`${SP}/soukatsu${M}/extract.json`, "utf8")); } catch { continue; }
  for (const f of sheets) {
    const on = OFF[f.office];
    if (!on) continue;
    for (const r of f.rows) {
      const code = nn(r._code);
      // ⚠ 茂原の総括表は 氏名が「合計」の集計行にも 従業員コードが入っている。氏名でも弾く
      if (!code || String(r._code).includes("合計") || /合計|小計/.test(String(r["氏名"] ?? ""))) continue;
      const amount = num(r["育児手当"]);
      if (amount <= 0) continue;
      const k = `${on}|${code}|${M}`;
      if (hasForm.has(k)) {
        // ★ 既定では 書式に行がある月は触らない。INCLUDE_FORM_ROWS=1 のときだけ ② に合わせる
        //   (2026-09-23 user「記録だけしておいて」= 調べた結果は残すが 投入はしない)
        if (!INCLUDE_FORM_ROWS) continue;
        const now = ours.get(k);
        if (now === undefined) { skipped.push(`${f.office} ${M} ${r["氏名"]}: 当方の計算結果が無い`); continue; }
        if (Math.abs(now - amount) <= ROUNDING) continue;   // 按分の丸め。触らない
      }
      if (already.get(k) === amount) continue;         // 冪等
      if (already.has(k)) { skipped.push(`${f.office} ${M} ${r["氏名"]}: 手入力 ${already.get(k)} と ② ${amount} が違う (触らない)`); continue; }
      ops.push({ office_number: on, employee_number: code, processing_month: M, item_key: "childcare_allowance", numeric_value: amount,
        note: hasForm.has(k)
          ? "総括表の育児手当に合わせた (書式の金額が null / 何月分がずれている 等。本稼働後は書式を直す) 2026-09-23"
          : "総括表の育児手当より (事業所書式に保育料の行が無いため。本稼働後は書式に入れる) 2026-09-23",
        label: `${f.office} ${M} ${r["氏名"]} ${amount.toLocaleString()} 円 ${hasForm.has(k) ? `(書式あり・当方 ${(ours.get(k) ?? 0).toLocaleString()} 円)` : "(書式に行なし)"}` });
    }
  }
}

console.log(`=== 育児手当の手入力 (書式に保育料が無い月) ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
