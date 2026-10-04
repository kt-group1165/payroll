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
const LEGAL_ITEM = "legal_within_overtime_minutes";

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
  // 福田 八重子 (Ｈａｎａヘルパーステーション高品・事務員/月給) 2026-10-04 追加
  //   高品 R8.5 社員.pdf p64 の欄外に青字で「残 33.5h」(用紙の残業 28:00 に「+④5.5h」)。
  //   ★ 同じ PDF の p65 に 4 月の出勤簿 (実績) が入っていて 4/23〜30 の残業 5.5h はそちら。
  //   当方の 4 月の取込は 4/23〜30 が 8:30-17:30 の予定値 (残業 0) なので 二重払いにはならない。
  { off: "1270402116", emp: "221006", m: "202605", min: 2010, src: "高品 R8.5 p64 欄外 青字「残 33.5h」(28h + ④5.5h の繰越)" },
  // 小原 奈保子 (リンクスヘルパーステーション・事務員/月給) 2026-10-04 追加
  //   茂原 R8.5 社員.pdf p49: 5/2(土・公休) 10h の振替が 5/20・5/27 (一部振替休・不足 Δ4:30)。
  //   日残業の合計 24:00 を消して 赤で「27:30」(5/2 の 02:00 → 7:30 等)。欄外に計算メモ。
  //   ★ 日ごとの書き換えが複雑なので 日別には入れず 分数だけ入れる。
  //   高品 R8.8 社員.pdf p33 の欄外に赤で「残 32h」「法内 0.5h」「通 66km」「出 3km」(週残業 02:30 → 3:30 に訂正)。
  //   ★ 当方の取込行には 日残業・週残業の欄が入っておらず 日 8h 超 + 週 40h 超 で 31h (1,860 分) になる。法内 30 分と km は当方も一致
  { off: "1270402116", emp: "221006", m: "202608", min: 1920, src: "高品 R8.8 p33 欄外「残 32h」「法内 0.5h」(週残業 02:30→3:30)" },
  // 黒田 美和 (リンクスヘルパーステーション山武・事務員/月給) 2026-10-04 追加
  //   山武 R8.8 社員.pdf p41: 8/10 8:20→8:00・8/24 8:15→8:00 と 日残業 00:20 / 00:15 を赤で消し、欄外に「残 12.5h」「早 3h」。
  //   (8/1 土 の 週残 08:00 + 日残 03:00 は「11h」と認めている。30 分未満の端数だけ消した)
  //   ★ 時刻 (18:20 / 18:15) は直していないので 出勤簿からは出せない。分数だけ入れる
  { off: "1279000366", emp: "260302", m: "202608", min: 750, src: "山武 R8.8 p41 欄外「残 12.5h」(8/10・8/24 の 日残 00:20/00:15 を赤で消し)" },
  // 小原 奈保子 202603 — 茂原 R8.3 社員.pdf p53。3/1(日・公休) 8.5h の振替が 3/11・3/26 (一部振替休)。
  //   3/7 の 週残業 08:00 に赤の ×。最終的に丸で囲んだ数字が「12.5h」(残業) と「7.5h」(法内)。
  //   (赤の「残 16.5h→16h」「法内 3h」は途中の計算で消されている)。legal = 法内残業 (legal_within_overtime_minutes)
  { off: "1271500942", emp: "438", m: "202603", min: 750, legal: 450, src: "茂原 R8.3 p53 欄外 丸囲み「12.5h」「7.5h」(3/7 週残業 08:00 に赤×)" },
  { off: "1271500942", emp: "438", m: "202605", min: 1650, src: "茂原 R8.5 p49 日残業合計 24:00 を消して 赤「27:30」(5/2 公休出勤の振替を差し引き)" },
];

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();                       // ★ PostgREST は空ボディを返すことがある
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
};

// ── ② の値と突き合わせてから入れる (片方だけで入れない)
const offs = [...new Set(PLAN.map((p) => p.off))];
// ★ 職員番号でも絞る (事業所だけだと 1000 行上限で切れて「② に無い」と誤報する。2026-10-04 に実際に踏んだ)
const emps = [...new Set(PLAN.map((p) => p.emp))];
const souk = await q(`payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data&office_number=in.(${offs.join(",")})&employee_number=in.(${emps.join(",")})&limit=1000`);
if (souk.length >= 1000) { console.error("★ ② が 1000 行に達しました。切れている可能性があるので中止します"); process.exit(2); }
const sKey = (o, e, m) => `${o}|${String(e).replace(/^0+/, "")}|${m}`;
const soukOf = new Map(souk.map((s) => [sKey(s.office_number, s.employee_number, s.processing_month), s.row_data]));
let bad = 0;
console.log("\n事業所        職員     月       手書き(分)  ② 残業(分)  手書き法内  ② 法内  ② 出勤時間  氏名");
for (const p of PLAN) {
  const d = soukOf.get(sKey(p.off, p.emp, p.m));
  const ot2 = Number(d?.["残業"] ?? 0), w2 = Number(d?.["出勤時間"] ?? 0), lw2 = Number(d?.["法内残業"] ?? 0);
  // ★ 法内残業 (legal) は 書いてある人月だけ 比べて入れる (2026-10-04 小原 202603 で追加)
  const ok = d && ot2 === p.min && (p.legal === undefined || lw2 === p.legal);
  if (!ok) bad++;
  console.log(`${p.off}  ${String(p.emp).padEnd(7)} ${p.m}  ${String(p.min).padStart(8)}  ${String(ot2).padStart(9)}  ${String(p.legal ?? "-").padStart(9)}  ${String(lw2).padStart(6)}  ${String(w2).padStart(9)}  ${d?.["氏名"] ?? "★ ② に無い"}${ok ? "" : "   ★ 不一致"}`);
}
if (bad) { console.error(`\n★ ${bad} 件で 手書き と ② が違います。★ 読み違いの可能性。中止します`); process.exit(2); }

// 入れるもの = (人月, 項目, 値)。残業は全件、法内残業は legal を書いた人月だけ
const items = PLAN.flatMap((p) => [
  { p, key: ITEM, val: p.min, what: "残業" },
  ...(p.legal !== undefined ? [{ p, key: LEGAL_ITEM, val: p.legal, what: "法内残業" }] : []),
]);
const cur = await q(`payroll_monthly_inputs?select=office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(${ITEM},${LEGAL_ITEM})&office_number=in.(${offs.join(",")})&employee_number=in.(${emps.join(",")})&limit=1000`);
if (cur.length >= 1000) { console.error("★ 手入力が 1000 行に達しました。中止します"); process.exit(2); }
const curOf = new Map(cur.map((r) => [`${sKey(r.office_number, r.employee_number, r.processing_month)}|${r.item_key}`, Number(r.numeric_value ?? 0)]));
const iKey = (t) => `${sKey(t.p.off, t.p.emp, t.p.m)}|${t.key}`;
const todo = items.filter((t) => curOf.get(iKey(t)) !== t.val);
console.log(`\n対象 ${PLAN.length} 人月 (${items.length} 項目) / 入れる・直すもの ${todo.length} 項目`);
for (const t of todo) console.log(`  ${EXECUTE ? "実行" : "予定"} ${t.p.off} ${t.p.emp} ${t.p.m} ${t.what} → ${t.val} 分`);
if (!todo.length) { console.log("既に入っています。何もしません"); process.exit(0); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

for (const t of todo) {
  const { p } = t;
  const note = `スキャンPDF (欄外の手書き) ${p.src}。② の${t.what} ${t.val}分 と一致。2026-10-02`;
  if (curOf.has(iKey(t))) {
    await q(`payroll_monthly_inputs?office_number=eq.${p.off}&employee_number=eq.${p.emp}&processing_month=eq.${p.m}&item_key=eq.${t.key}`,
      { method: "PATCH", body: JSON.stringify({ numeric_value: t.val, note }) });
    console.log(`  更新 ${p.off} ${p.emp} ${p.m} ${t.what} → ${t.val} 分`);
  } else {
    await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify({ office_number: p.off, employee_number: p.emp, processing_month: p.m, item_key: t.key, numeric_value: t.val, note }) });
    console.log(`  追加 ${p.off} ${p.emp} ${p.m} ${t.what} → ${t.val} 分`);
  }
}
console.log("\n⚠ /payroll で 該当の 事業所 × 月 を再計算してください:");
for (const o of offs) { const ms = [...new Set(todo.filter((t) => t.p.off === o).map((t) => t.p.m))]; if (ms.length) console.log(`   ${o}  ${ms.join(" ")}`); }
