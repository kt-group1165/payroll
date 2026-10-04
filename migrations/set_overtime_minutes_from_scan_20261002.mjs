/**
 * 月給者の 残業 を スキャン出勤簿の **欄外の手書き** から入れる (2026-10-02)。
 *
 *   node migrations/set_overtime_minutes_from_scan_20261002.mjs              # DRY RUN
 *   node migrations/set_overtime_minutes_from_scan_20261002.mjs --execute
 *   PAYROLL_ENV=staging node migrations/set_overtime_minutes_from_scan_20261002.mjs --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * ★ **② の残業は 出勤簿の欄外に手書きされた時間を そのまま払っている。**
 *   日々の時刻 (拘束時間 − 中抜け) から 当方の規則 (日 8h 超 + 週 40h 超) で出しても 一致しない。
 *   実例 稲葉 202606: 用紙は ほぼ全日 9:00〜18:00・中抜け 12:00〜13:00 = 8h ちょうどで、
 *   当方の規則なら 90 分にしかならないが、★ 用紙の左余白に 赤字で「残 9.5h」とあり ② は 570 分 払っている。
 *   → ★ これは 既に `payroll-calc.ts` の overtime_minutes_override のコメントに
 *     「残業 = 出勤時間 − 480 × 出勤日数 は 42 人月中 34 しか合わない (★ 稲葉香織 4 が外れる)」
 *     「PDF の出勤簿 (赤字の手書き訂正が正) から人が入れる」と書かれていた。足りなかったのは **データだけ**。
 *
 * ── 出どころ ────────────────────────────────────────────────────────────
 *   Box\10F内共有\02_共有\10_給与\02_スキャン\Ｇ　リンクス\大網\大網　R8\大網　R8.<n>\R8.<n>　大網　社員.pdf
 *   ★ 2 ページ組 (前半 1〜17 日 / 後半 18〜末日 + 合計)。★ 赤字は **後半ページの左余白**。
 *
 *   月      ページ   用紙の合計              赤字      ② の 出勤時間/出勤日数/残業
 *   202603  p40/41   16.5日 有4.5  133.5h   残 1.5h   8,010 / 16.5 / 90     ✔ 3 つとも一致
 *   202605  p34/35   19日   有1    148.5h   残 3.5h   8,910 / 19   / 210    ✔
 *   202606  p35/37   20日   有2    161.5h   残 9.5h   9,690 / 20   / 570    ✔
 *   202607  p37/38   20     有2    161h     残 1h     9,660 / 20.5 / 60     ✔
 *   202608  p50/51   19日   有1    155h     残 3h     9,300 / 20   / 180    ✔
 *   ⚠ 202604 は ② の残業が 0 で 当方も 0。★ 入れない。
 *
 * ★ 出どころは 2 つ独立している (① 事業所が出した出勤簿の赤字 / ② 旧システムの支給額) ので
 *   [[feedback_two_sources_before_filling_input]] を満たす。★ ② だけを根拠にはしていない。
 *
 * ⚠ 法内残業 (legal_within_overtime_minutes) は この人の ② に列が立っていないので 入れない。
 * ⚠ 投入後に /payroll で リンクスヘルパーステーション大網白里 の 該当 5 か月を **再計算**すること。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const STAGING = process.env.PAYROLL_ENV === "staging";
const env = {};
for (const p of STAGING ? [".env.staging"] : ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ 接続情報が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
console.log(`[DB] ${STAGING ? "staging" : "本番"} ${/https:\/\/([a-z0-9]+)\./.exec(SB)?.[1]}`);

const ITEM = "overtime_minutes";

/**
 * ★ 1 行 = 1 人月。★ min は **用紙の欄外に手書きされた残業時間**。
 * ⚠ ② の「残業」列と一致しなければ 投入しない (下で検算して 違えば exit 2)。
 * ⚠ 職員番号は **事業所をまたいで重複する** (230702 は 後藤雅代・根本由香・稲葉香織 の 3 人)。
 *   ★ 必ず 事業所番号と対で引くこと ([[payroll_master_role_vs_salary_history]] と同じ型の罠)。
 */
const PLAN = [
  // 稲葉 香織 (リンクスヘルパーステーション大網白里・事務員/月給)
  //   Box\…_スキャン\Ｇ　リンクス\大網\大網　R8\大網　R8.<n>\R8.<n>　大網　社員.pdf
  //   ★ 2 ページ組 (前半 1〜17 日 / 後半 18〜末日 + 合計)。赤字は **後半ページの左余白**
  { off: "1275800892", emp: "230702", m: "202603", min: 90,  src: "大網 R8.3 p41 左余白「残 1.5h」/ 合計 16.5日 有4.5 133.5h" },
  { off: "1275800892", emp: "230702", m: "202605", min: 210, src: "大網 R8.5 p35 左余白「残 3.5h」/ 合計 19日 有1 148.5h" },
  { off: "1275800892", emp: "230702", m: "202606", min: 570, src: "大網 R8.6 p37 左余白「残 9.5h」/ 合計 20日 有2 161.5h" },
  { off: "1275800892", emp: "230702", m: "202607", min: 60,  src: "大網 R8.7 p38 左余白「残 1h」/ 合計 20 有2 161h" },
  { off: "1275800892", emp: "230702", m: "202608", min: 180, src: "大網 R8.8 p51 左余白「残 3h」/ 合計 19日 有1 155h" },
  // 牛来 葉子 (Ｈａｎａおゆみ野・事務員/月給)
  //   ★ 根拠は migrations/_attendance_tsv/daily_oyumino_ushiki_231204.tsv の冒頭に既に記録済み:
  //     R8.5 の用紙 p99 に「4/30日 8→11時間に変更です」、p98 の欄外に
  //     「⑤168h+④3h=171h」「残 ⑤4h+④3h=7h」。★ 7h = 420 分 = ② の残業。
  //   ⚠ 当方に 前月繰越の仕組みが無く 日別を入れても 残業は 0 のままなので、
  //     202605 は TSV から **意図的に外してある**。★ ここで分数だけ入れる。
  { off: "1270501180", emp: "231204", m: "202605", min: 420, src: "おゆみ野 R8.5 p98 欄外「残 ⑤4h+④3h=7h」(4/30 の 8→11h 訂正 3h の繰越を含む)" },
  // 森田 由香理 (君津ムツミヘルパーステーション・事務員/月給) 2026-10-04 追加
  //   君津 R8.5 社員.pdf p23 の欄外に赤で「残 ⑤6h+④1h=7h」(5/1 日残 1:00 + 5/31(日) 5:00 = 6h に 4 月ぶん 1h)。
  //   ★ 同じ PDF の p24 に 4 月の出勤簿が出し直されて入っている (ピンクで丸囲み)。
  //   当方は出勤簿から 6h (360 分) までしか出せない。② は 420。
  { off: "1273001626", emp: "211102", m: "202605", min: 420, src: "君津 R8.5 p23 欄外「残 ⑤6h+④1h=7h」(4 月ぶん 1h の繰越を含む)" },
];

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();                       // ★ PostgREST は空ボディを返すことがある
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
};

// ── ② の値と突き合わせてから入れる (片方だけで入れない)
const offs = [...new Set(PLAN.map((p) => p.off))];
const souk = await q(`payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data&office_number=in.(${offs.join(",")})`);
const sKey = (o, e, m) => `${o}|${String(e).replace(/^0+/, "")}|${m}`;
const soukOf = new Map(souk.map((s) => [sKey(s.office_number, s.employee_number, s.processing_month), s.row_data]));
let bad = 0;
console.log("\n事業所        職員     月       手書き(分)  ② 残業(分)  ② 出勤時間  氏名");
for (const p of PLAN) {
  const d = soukOf.get(sKey(p.off, p.emp, p.m));
  const ot2 = Number(d?.["残業"] ?? 0), w2 = Number(d?.["出勤時間"] ?? 0);
  const ok = d && ot2 === p.min;
  if (!ok) bad++;
  console.log(`${p.off}  ${String(p.emp).padEnd(7)} ${p.m}  ${String(p.min).padStart(8)}  ${String(ot2).padStart(9)}  ${String(w2).padStart(9)}  ${d?.["氏名"] ?? "★ ② に無い"}${ok ? "" : "   ★ 不一致"}`);
}
if (bad) { console.error(`\n★ ${bad} 件で 手書き と ② が違います。★ 読み違いの可能性。中止します`); process.exit(2); }

const cur = await q(`payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.${ITEM}&office_number=in.(${offs.join(",")})`);
const curOf = new Map(cur.map((r) => [sKey(r.office_number, r.employee_number, r.processing_month), Number(r.numeric_value ?? 0)]));
const todo = PLAN.filter((p) => curOf.get(sKey(p.off, p.emp, p.m)) !== p.min);
console.log(`\n対象 ${PLAN.length} 人月 / 入れる・直すもの ${todo.length} 人月`);
if (!todo.length) { console.log("既に入っています。何もしません"); process.exit(0); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

for (const p of todo) {
  const note = `スキャンPDF (欄外の手書き) ${p.src}。② の残業 ${p.min}分 と一致。2026-10-02`;
  const k = sKey(p.off, p.emp, p.m);
  if (curOf.has(k)) {
    await q(`payroll_monthly_inputs?office_number=eq.${p.off}&employee_number=eq.${p.emp}&processing_month=eq.${p.m}&item_key=eq.${ITEM}`,
      { method: "PATCH", body: JSON.stringify({ numeric_value: p.min, note }) });
    console.log(`  更新 ${p.off} ${p.emp} ${p.m} → ${p.min} 分`);
  } else {
    await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify({ office_number: p.off, employee_number: p.emp, processing_month: p.m, item_key: ITEM, numeric_value: p.min, note }) });
    console.log(`  追加 ${p.off} ${p.emp} ${p.m} → ${p.min} 分`);
  }
}
console.log("\n⚠ /payroll で 該当の 事業所 × 月 を再計算してください:");
for (const o of offs) console.log(`   ${o}  ${[...new Set(todo.filter((p) => p.off === o).map((p) => p.m))].join(" ")}`);
