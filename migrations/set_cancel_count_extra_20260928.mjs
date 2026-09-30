/**
 * 実績に無いキャンセル (事業所が紙で申告したもの) を payroll_monthly_inputs に入れる (2026-09-28)。
 *
 *   node migrations/set_cancel_count_extra_20260928.mjs             # DRY RUN
 *   node migrations/set_cancel_count_extra_20260928.mjs --execute   # 書き込む
 *   node migrations/set_cancel_count_extra_20260928.mjs --delete --execute   # 入れた行だけ消す
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * 旧システムは キャンセルを 総括表データには出すが ★ 実績データには出さない月がある。
 *   大網 202605  実績 2,144 行 → キャンセル 0 件 / 総括表データ → 2 件 ¥1,600
 *   五井 202603  日別 615 行 → キャンセル 0 件
 * 当方は 実績 (MEISAI) だけを取り込むので キャンセルが入らない。
 * 202603〜08 で 「① ② が払い 当方が 0 円」は 13 人月 ¥11,200。
 *
 * ── 元データ (スキャンPDFの紙。2026-09-28 に 1 枚ずつ確認した) ──────────────
 * ★ 紙は ① とは独立した材料。両方が一致したものだけ入れる (feedback_two_sources_before_filling_input)。
 *
 *   大網 (Ｇ　リンクス/大網/大網　R8/大網　R8.5|R8.7 の「ﾊﾟｰﾄ.pdf」)
 *     「5月分 キャンセル手当計上分」 p2
 *        柴田 彩     2026/5/12(火) 南山○子  生活3        60分  800
 *        柴田 彩     2026/5/29(金) 黒田○    身体1        30分  800
 *        杉田 智恵子 2026/5/7(木)  岡田千鶴子 訪問独サ11   45分  800   合計 2,400 = ① と一致
 *     「7月分 キャンセル手当計上分」 p7
 *        伊藤 瑠奈   2026/7/17(金) 15:00〜16:00 田中鮎子 家事援助 60分 800
 *        金井 珠美   2026/7/30(木) 15:00〜16:00 石井鈴江 家事援助 60分 800  合計 1,600 = ① と一致
 *
 *   おゆみ野 (Ｋ04　Hanaおゆみ野/おゆみ野　R8/おゆみ野　R8.5 の「ﾊﾟｰﾄ.pdf」)
 *     「Hana別途手当て申請書（パート）」= 人ごとの定型。★「ドタキャン 800/回 × 件数 = 金額 / 日時」の行がある
 *        p14 飛田野 絵利香 (250603)  ドタキャン 800 × 1 / 5/15 木土様
 *        p70 松本 松代   (3155)    ドタキャン 800 × 1 / 5/27 山下様
 *
 *   五井 (Ｋ06　五井/KT五井　R8/五井　R8.3 の「ﾊﾟｰﾄ.pdf」) p2 = 本社⇄事業所の FAX
 *        本社「宮崎さん 23日9:00〜の一宮さまはドタキャンでよろしいでしょうか」
 *        事業所 (手書き)「ドタキャンで処理いたしました」4/4(土) 加瀬
 *
 *   東郷 (K15　東郷/東郷　R8/東郷　R8.3 の「ﾊﾟｰﾄ.pdf」) p2 = 本社→事業所の照会文書
 *        「斎藤さん 調整費でドタキャンが上がってきていたのですが、カレンダーを確認したところ、
 *          該当日にキャンセルの実績が上がっていませんでした。支給対象か否か教えてください」
 *        → ★ 「実績に無い」ことを 本社も認識している。① は 800 円を払っている
 *
 * ── 入れないもの (紙が見つからなかった 5 人月 ¥4,000) ──────────────────────
 *   大網 202606 岡崎明日香 / 東郷 202605 若菜多喜子 / 東郷 202606 佐久間千春
 *     … その月の束を 全ページ見たが キャンセルの紙が無い
 *   大網 202608 岡崎明日香 / 大網 202608 伊藤瑠奈
 *     … ★ 202608 (R8.8) のスキャンがまだ無い
 *   ★ 材料が 1 つ (① だけ) になるので 入れない。紙が出てきたら足す。
 *
 * 冪等。同じキーが既にあれば 上書きせず そのまま (値が違えば 報告して止まる)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const ITEM_KEY = "cancel_count_extra";

/** 事業所番号 | 社員番号 | 処理年月 | 件数 | 根拠 */
const TARGETS = [
  ["1275800892", "337", "202605", 2, "大網 5月分キャンセル手当計上分: 5/12 南山○子 生活3 60分 / 5/29 黒田○ 身体1 30分"],
  ["1275800892", "366", "202605", 1, "大網 5月分キャンセル手当計上分: 5/7 岡田千鶴子 訪問独サ11 45分"],
  ["1275800892", "260602", "202607", 1, "大網 7月分キャンセル手当計上分: 7/17 15:00-16:00 田中鮎子 家事援助 60分"],
  ["1275800892", "452", "202607", 1, "大網 7月分キャンセル手当計上分: 7/30 15:00-16:00 石井鈴江 家事援助 60分"],
  ["1270501180", "250603", "202605", 1, "おゆみ野 Hana別途手当て申請書: ドタキャン 800×1 5/15 木土様"],
  ["1270501180", "3155", "202605", 1, "おゆみ野 Hana別途手当て申請書: ドタキャン 800×1 5/27 山下様"],
  ["1272401967", "454", "202603", 1, "五井 本社⇄事業所FAX: 23日9:00〜 一宮様。事業所が手書きで「ドタキャンで処理いたしました」"],
  ["1271502518", "210927", "202603", 1, "東郷 本社照会文書: 調整費でドタキャンが上がってきたが実績に無い。① は 800 円を払っている"],
];

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  // ⚠ PostgREST の POST/DELETE は Prefer: return=representation が無いと **本文を返さない**。
  //   r.json() をそのまま呼ぶと 書き込みが成功したあとに SyntaxError で落ちる (2026-09-30 に踏んだ)。
  const body = await r.text();
  return body ? JSON.parse(body) : null;
};

console.log(`=== 実績に無いキャンセルを 手入力に入れる ${DELETE ? "【削除】" : EXECUTE ? "【実行】" : "(DRY RUN)"} ===`);
const existing = await q(`payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value,note&item_key=eq.${ITEM_KEY}`);
const byKey = new Map(existing.map((r) => [`${r.office_number}|${r.employee_number}|${r.processing_month}`, r]));
console.log(`既にある ${ITEM_KEY} の行: ${existing.length}`);

if (DELETE) {
  const ids = TARGETS.map(([o, e, m]) => byKey.get(`${o}|${e}|${m}`)?.id).filter(Boolean);
  console.log(`消す対象 ${ids.length} 行`);
  if (!EXECUTE) { console.log("(DRY RUN。--delete --execute で実行)"); process.exit(0); }
  for (const id of ids) await q(`payroll_monthly_inputs?id=eq.${id}`, { method: "DELETE" });
  console.log(`${ids.length} 行を消しました`);
  process.exit(0);
}

const toInsert = [];
let conflict = 0;
for (const [office, emp, month, count, why] of TARGETS) {
  const cur = byKey.get(`${office}|${emp}|${month}`);
  if (cur) {
    if (Number(cur.numeric_value) !== count) { console.error(`★ NG ${office}|${emp}|${month} 既存 ${cur.numeric_value} ≠ 入れたい ${count}。止めます`); conflict++; }
    else console.log(`  済 ${office}|${emp}|${month} ${count} 件 (変更なし)`);
    continue;
  }
  console.log(`  入れる ${office}|${emp}|${month} ${count} 件 × 800 円 = ${count * 800} 円`);
  console.log(`         ${why}`);
  toInsert.push({ office_number: office, employee_number: emp, processing_month: month, item_key: ITEM_KEY, numeric_value: count, note: why });
}
if (conflict > 0) { console.error(`★ 既存の値と違う行が ${conflict} 件あります。人が見てから直してください`); process.exit(2); }
console.log(`\n入れる ${toInsert.length} 行 / 合計 ${toInsert.reduce((s, r) => s + r.numeric_value, 0) * 800} 円`);
if (!EXECUTE) { console.log("(DRY RUN。--execute で書き込みます)"); process.exit(0); }
if (toInsert.length > 0) await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify(toInsert) });
console.log(`${toInsert.length} 行を入れました。★ 次に 大網 202605/202607・おゆみ野 202605・五井 202603・東郷 202603 を再計算すること`);
