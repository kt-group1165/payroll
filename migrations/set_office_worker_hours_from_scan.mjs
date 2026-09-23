/**
 * 出勤簿が CSV で取り込めない事務員 7 名の勤務時間を入れる (2026-09-23)。
 *
 *   node migrations/set_office_worker_hours_from_scan.mjs            # DRY RUN
 *   node migrations/set_office_worker_hours_from_scan.mjs --execute
 *
 * 7 名とも 出勤簿は Box のスキャン PDF にしかない (テキスト層なし・画像)。
 * **全員 ﾊﾟｰﾄ.pdf ではなく 社員.pdf に入っていた。**
 * 各 社員PDF の 1 ページ目が その事業所の総括表 (職員番号・氏名・出勤日数・出勤時間) なので、
 * それを独立した照合材料にして 35 人月すべて突合した (欠測 0)。
 *
 * ⚠ **様式が事業所ごとに 4 種類あり「勤務時間合計」の意味が違う。**
 *   おゆみ野   「合計時間(拘束)」と「請求時間(実働=拘束−休憩)」が並記。**総括表が採るのは請求時間**
 *   五井       「合計 / 休憩 / 勤務時間」の 3 列
 *   花見川・八千代・姉崎ムツミ・大網  「合計勤務時間」1 つ
 *
 * ⚠ **手書きの訂正が入っているものは 手書きが正** (総括表と一致することで裏が取れた)。
 *   五井 加瀬 3〜5月・7月 / おゆみ野 世古 3月 / 大網 稲葉 4月の日数・5月の時間 /
 *   姉崎ムツミ 本田 3月・6月の日数 / おゆみ野 牛来 4月 (別紙の「正」版)
 *
 * ⚠ おゆみ野 牛来の 4 月は **2 枚ある**。4月PDF が「誤」、5月PDF p99 が「正」(4/30 を 8h→11h)。
 *   総括表の 4 月は「誤」版のまま 177:30 で、**+3h は 5 月に繰り越されている** (5月 168+3=171)。
 *   ここでは **総括表に合わせて** 4月 177:30 / 5月 171:00 を入れる。
 *
 * ⚠ 未解決が 1 件: 姉崎ムツミ 本田の 5 月の出勤日数 (出勤簿 20 日 / 総括表 19.5 日・訂正の手書き無し)。
 *   時間は 156:00 で一致するので 時間だけ入れる。
 *
 * 冪等: 既に同じ値なら触らない。
 */
const EXECUTE = process.argv.includes("--execute");

const hm = (h, m = 0) => h * 60 + m;
/** 事業所番号 → { 職員番号: { 氏名, 月: 分 } } */
const PLAN = [
  { office: "1270501180", num: "3056", name: "世古 啓子", note: "おゆみ野。請求時間(実働)を採る。3月は手書きの 171:30 が正",
    minutes: { "202603": hm(171, 30), "202604": hm(181), "202605": hm(171), "202606": hm(172, 30), "202607": hm(171) } },
  { office: "1270501180", num: "231204", name: "牛来 葉子", note: "おゆみ野。4月は「誤」版のまま総括表に載り +3h は5月に繰り越し",
    minutes: { "202603": hm(177, 30), "202604": hm(177, 30), "202605": hm(171), "202606": hm(170, 30), "202607": hm(137) } },
  { office: "1270201930", num: "241213", name: "三島 由佳", note: "花見川。km 欄が無く 日額 292〜310 円の積み上げ",
    minutes: { "202603": hm(174), "202604": hm(168), "202605": hm(164), "202606": hm(176), "202607": hm(184) } },
  { office: "1272401967", num: "674", name: "加瀬 真紀江", note: "五井。3〜5月・7月は手書きが正 (総括表と一致)",
    minutes: { "202603": hm(171, 24), "202604": hm(161, 39), "202605": hm(154, 22), "202606": hm(182, 38), "202607": hm(174, 41) } },
  { office: "1272400829", num: "284", name: "本田 亜美", note: "姉崎ムツミ。5月の出勤日数だけ総括表と食い違う (時間は一致)",
    minutes: { "202603": hm(137, 30), "202604": hm(155), "202605": hm(156), "202606": hm(172), "202607": hm(168) } },
  { office: "1275800892", num: "230702", name: "稲葉 香織", note: "大網。様式は運転日報。通勤の欄が無い。4月の日数・5月の時間は手書きが正",
    minutes: { "202603": hm(133, 30), "202604": hm(146), "202605": hm(148, 30), "202606": hm(161, 30), "202607": hm(161) } },
  { office: "1272603851", num: "250207", name: "五十嵐 尚子", note: "八千代。走行距離は業務走行で 通勤ではない",
    minutes: { "202603": hm(168), "202604": hm(164), "202605": hm(160), "202606": hm(168), "202607": hm(184) } },
];

import { readFileSync } from "node:fs";
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
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
  return j;
};
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const fmt = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

const offices = await get("payroll_offices?select=id,office_number");
const onOf = new Map(offices.map((o) => [o.id, o.office_number]));
const exist = await get("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.office_work_minutes");
const already = new Map(exist.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value ?? 0)]));

const ops = [], skipped = [];
for (const p of PLAN) {
  const cands = (await get(`payroll_employees?select=id,name,office_id&employee_number=eq.${p.num}`)).filter((e) => onOf.get(e.office_id) === p.office);
  if (cands.length !== 1) { skipped.push(`★ ${p.name} (${p.num}): 職員が ${cands.length} 件`); continue; }
  const surname = p.name.split(" ")[0];
  if (!cands[0].name.includes(surname)) { skipped.push(`★ ${p.name} (${p.num}): 名前が違う (${cands[0].name})`); continue; }
  for (const [M, min] of Object.entries(p.minutes)) {
    const k = `${p.office}|${p.num}|${M}`;
    if (already.get(k) === min) continue;
    ops.push({ office_number: p.office, employee_number: p.num, processing_month: M, item_key: "office_work_minutes", numeric_value: min,
      note: `出勤簿 (Box のスキャンPDF・社員.pdf) より。${p.note}。本稼働後は出勤簿から 2026-09-23`,
      label: `${p.name} (${p.num}) ${M} ${fmt(min)}` });
  }
}

console.log(`=== 事務員の勤務時間 (スキャンPDFより) ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
