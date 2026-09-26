/**
 * 総括表 xlsm (原本) と payroll_soukatsu_rows (検証用テーブル) の 金額列だけの常設diff
 *
 *   npm run check:soukatsu-source              # xlsm を再抽出して diff (重い。数分かかる)
 *   npm run check:soukatsu-source -- --update   ★ 基準値方式の数だけ更新
 *
 * ── なぜこの検査があるか (2026-09-26 給与D) ──────────────────────────────────
 *   payroll_soukatsu_rows を作った元の xlsm→JSON 抽出スクリプトがリポジトリに残っておらず、
 *   実データ突合(おゆみ野の会議手当11件)で「実在しない値」「他職員の値との入れ替わり」
 *   「孤立値」が見つかった。同じ調査を後日また割り当てる事故 (このプロジェクトで前例あり:
 *   生活援助の回数制限を2回調査した) を避けるため、一度きりの調査を常設検査にする。
 *
 * ── この検査が見ていないもの (誤解防止のため明記) ───────────────────────────
 *   ★ 総支給額 は対象外。原本の「総支給額（パート）」1列と DB の「総支給額」は別概念
 *     (DB側は他の手当も足し込んだ合計で、パート単体列だけでは再現できない)。
 *     入れると総支給額だけで1,967件の偽陽性が出ることを2026-09-26に実証済み。
 *   ★ 時刻列 (訪問時間 等) は対象外。原本は "HH:MM" 文字列、DB は分の整数で、
 *     値は同じでも型が違うため比較しない (時刻専用の別検査を作るならそちらで)。
 *   ★ 氏名列は対象外。全角/半角スペースの表記ゆれがあるだけで実害が無い。
 *   ★ 勤続手当・調整手当・有給休暇手当・誤差・残業総額・残業単価 は対象外。
 *     列名の枝分かれが多い (勤続手当2/開始/対象者 等) か、DB側の計算専用フィールドで
 *     原本に対応列が無いかで、安全な1対1ペアリングが作れなかった (2026-09-26 時点)。
 *     今後 対応が確認できたら追加してよい。
 *
 * ── 基準値方式 (なぜ 164 件か) ─────────────────────────────────────────────
 *   対象6列(通勤費/出張費/処遇改善補助金手当/育児手当/本人給/集計項目小計)で
 *   2026-09-26 に実測: 21,490セル中 164件 (0.76%) が「両方に値がありかつ違う」。
 *   19事業所に1〜27件で散在 (おゆみ野は11件で19事業所中5位、突出せず)。
 *   大半は出張費の距離データが抽出後に修正されたとみられるもの (単価は月次で完全一致を
 *   別途確認済み。project_soukatsu 系のメモリ参照)。
 *   おゆみ野の会議1/2/3件数まわり11件は原本と突合して確証済みの本物 (別途是正が必要)。
 *   ★ 0 を目指す検査ではない。**増えたら落ちる。**
 *   ⚠ 悪化したまま --update すると穴を焼き付けることになる。原因を潰してから更新すること。
 *   ⚠ import_soukatsu_rows.mjs の dedupe 修正 (2026-09-26 813ca46) をまだ取込に反映していない。
 *     反映後は基準値を取り直す必要があるかもしれない。
 *
 * ── 負のコントロール ───────────────────────────────────────────────────────
 *   DB側の1セルを意図的に+999999して壊し、③(both_present_diff)としてちゃんと検知されるかを
 *   毎回確認してから baseline 判定に入る。検知できなければ検査自体が壊れているので即FAIL。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const UPDATE = process.argv.includes("--update");
const BASELINE_PATH = "scripts/soukatsu-source-baseline.json";
const EXTRACT_OUT = process.env.OUT || "scripts/.soukatsu-extract-tmp";
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");

let failed = 0;
const fail = (msg: string) => { console.log(`  x ${msg}`); failed++; };
const pass = (msg: string) => console.log(`  o ${msg}`);
function expect(cond: boolean, msg: string) { if (cond) pass(msg); else fail(msg); }

type Baseline = { _readme: string[]; bothPresentDiff: number; denomCells: number };

console.log("=== check:soukatsu-source (総括表 原本 vs payroll_soukatsu_rows・金額6列のみ) ===");
console.log("この検査が見ていないもの: 総支給額(概念不一致で対象外) / 時刻列 / 氏名列 / 勤続手当・調整手当・有給休暇手当・誤差・残業総額・残業単価(1対1対応未確立)");

// --- 1. 原本を再抽出する (重い) ---
console.log("\n[1/3] 原本 xlsm を再抽出中 (数分かかることがあります)...");
if (existsSync(EXTRACT_OUT)) rmSync(EXTRACT_OUT, { recursive: true, force: true });
try {
  execSync(`node migrations/extract_soukatsu_from_xlsm.mjs --execute`, {
    env: { ...process.env, OUT: EXTRACT_OUT, MONTHS: MONTHS.join(",") },
    stdio: "inherit",
  });
} catch (e) {
  fail(`xlsm 抽出に失敗しました: ${(e as Error).message}`);
  process.exit(1);
}

// --- 2. DB (payroll_soukatsu_rows) を読む ---
console.log("\n[2/3] payroll_soukatsu_rows を読み込み中...");
const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  fail("SUPABASE_SERVICE_ROLE_KEY が無いので検査できません");
  process.exit(1);
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
async function fetchAll(path: string): Promise<any[]> {
  const out: any[] = []; let from = 0;
  for (;;) {
    const res = await fetch(SB + path, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const chunk = await res.json();
    if (!Array.isArray(chunk)) { throw new Error(`fetch失敗: ${path} ${JSON.stringify(chunk).slice(0, 300)}`); }
    out.push(...chunk);
    if (chunk.length < 1000) break;
    from += 1000;
  }
  return out;
}
const monthsIn = MONTHS.join(",");
const dbPart = (await fetchAll(`payroll_soukatsu_rows?sheet_kind=eq.part&processing_month=in.(${monthsIn})&select=office_number,employee_number,employee_name,processing_month,row_data`)).map((r) => ({ ...r, sheet_kind: "part" }));
const dbShaseki = (await fetchAll(`payroll_soukatsu_rows?sheet_kind=eq.shaseki&processing_month=in.(${monthsIn})&select=office_number,employee_number,employee_name,processing_month,row_data`)).map((r) => ({ ...r, sheet_kind: "shaseki" }));
const db = [...dbPart, ...dbShaseki];

// --- 3. diff ---
console.log("\n[3/3] diff 実行中...");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

// 厳密な1対1ペア。位置決め打ちをせず実データで確認した正確な列名のみ (総支給額は入れない。上のヘッダー参照)
const PAIRS: { label: string; fresh: string[]; db: string[] }[] = [
  { label: "本人給", fresh: ["本人給"], db: ["本人給"] },
  { label: "集計項目小計", fresh: ["集計項目小計"], db: ["集計項目小計"] },
  { label: "通勤費", fresh: ["通勤費"], db: ["通勤費"] },
  { label: "出張費", fresh: ["出張費"], db: ["出張費"] },
  { label: "処遇改善補助金手当", fresh: ["処遇改善補助金手当"], db: ["処遇改善補助金手当"] },
  { label: "育児手当", fresh: ["育児手当"], db: ["育児手当"] },
];
function pick(row_data: Record<string, unknown>, names: string[]) {
  for (const n of names) if (n in row_data) return row_data[n];
  return undefined;
}
function toNumOrError(v: unknown): { kind: "null" | "error" | "num" | "other"; value?: number } {
  if (v === null || v === undefined) return { kind: "null" };
  if (v instanceof Date) return { kind: "other" };
  if (typeof v === "number") return { kind: "num", value: v };
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return { kind: "null" };
    if (/^#/.test(t) || /error/i.test(t) || /エラー/.test(t)) return { kind: "error" };
    const n = Number(t.replace(/,/g, ""));
    if (Number.isFinite(n)) return { kind: "num", value: n };
    return { kind: "other" };
  }
  return { kind: "other" };
}

const fresh: any[] = [];
for (const m of MONTHS) {
  const p = `${EXTRACT_OUT}/soukatsu_extract_${m}.json`;
  if (!existsSync(p)) { fail(`抽出結果が無い: ${p}`); continue; }
  fresh.push(...JSON.parse(readFileSync(p, "utf8")));
}
const freshByKey = new Map<string, any>();
for (const r of fresh) freshByKey.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}|${r.sheet_kind}`, r);
const dbByKey = new Map<string, any>();
for (const r of db) dbByKey.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}|${r.sheet_kind}`, r);

// --- 負のコントロール: DB側の1セルを+999999して壊す。③として検知できるかを見る ---
// ⚠ fresh側にも同じキーがあり、かつ fresh側の値も数値でないと比較ループで「両方数値」の
//   分岐に入らず「検知できず」という誤判定になる。両方が数値のペアから選ぶこと
//   (2026-09-26 に一度この不具合で誤NGを出した)。
const negKey = [...dbByKey.keys()].find((k) => {
  if (!freshByKey.has(k)) return false;
  const dOk = toNumOrError(pick(dbByKey.get(k).row_data, PAIRS[0].db)).kind === "num";
  const fOk = toNumOrError(pick(freshByKey.get(k).row_data, PAIRS[0].fresh)).kind === "num";
  return dOk && fOk;
});
if (!negKey) { fail("負のコントロール用の行が見つからない (本人給が原本・DB双方で数値の行が無い)"); process.exit(1); }
const negRow = dbByKey.get(negKey);
const negOrig = Number(pick(negRow.row_data, PAIRS[0].db));
negRow.row_data = { ...negRow.row_data, "本人給": negOrig + 999999 };

let denomCells = 0, matchCells = 0;
const cat = { error: 0, oneSideOnly: 0, bothPresentDiff: 0 };
let negativeControlCaught = false;
const bothPresentFindings: { office: string; month: string; emp: string; name: string; field: string; fresh: number; db: number; diff: number }[] = [];

for (const key of new Set([...freshByKey.keys(), ...dbByKey.keys()])) {
  const f = freshByKey.get(key), d = dbByKey.get(key);
  if (!f || !d) continue; // 行そのものの有無 (原本のみ/DBのみ) は別観点。ここでは金額の値だけ見る
  const [office, emp, month] = key.split("|");
  for (const pr of PAIRS) {
    const fRaw = pick(f.row_data, pr.fresh);
    const dRaw = pick(d.row_data, pr.db);
    if (fRaw === undefined && dRaw === undefined) continue;
    denomCells++;
    const fv = toNumOrError(fRaw), dv = toNumOrError(dRaw);
    if (fv.kind === "error" || dv.kind === "error") { cat.error++; continue; }
    const fp = fv.kind === "num", dp = dv.kind === "num";
    if (fp && dp) {
      if (Math.abs((fv.value as number) - (dv.value as number)) < 0.01) { matchCells++; continue; }
      // ⚠ 負のコントロール自身のセルは基準値比較の分母に混ぜない (混ぜると毎回 baseline+1 になり
      //   正常なPASSでも「増えた」と誤検知する。2026-09-26 に一度これで誤FAILを出した)。
      if (key === negKey && pr.label === "本人給") { negativeControlCaught = true; continue; }
      cat.bothPresentDiff++;
      bothPresentFindings.push({ office, month, emp, name: d.employee_name, field: pr.label, fresh: fv.value as number, db: dv.value as number, diff: +((fv.value as number) - (dv.value as number)).toFixed(2) });
    } else if (fp !== dp) {
      cat.oneSideOnly++;
    } else matchCells++;
  }
}

console.log(`\n負のコントロール(本人給を+999999して壊す): ${negativeControlCaught ? "検知OK" : "★検知できず"}`);
expect(negativeControlCaught, "負のコントロールが③(両方値ありで違う)として検知される");
if (!negativeControlCaught) {
  console.log("  ★ 検知できない = この検査自体が壊れている可能性が高い。baseline判定はスキップします。");
  process.exit(1);
}

console.log(`\n分母(人月×対象6列で片方以上値あり): ${denomCells}`);
console.log(`一致: ${matchCells} (${(matchCells / denomCells * 100).toFixed(2)}%)`);
console.log(`不一致内訳: ①エラー値=${cat.error} ②片方だけ値あり=${cat.oneSideOnly} ③両方値ありで違う=${cat.bothPresentDiff}`);

const byOffice = new Map<string, number>();
for (const f of bothPresentFindings) byOffice.set(f.office, (byOffice.get(f.office) ?? 0) + 1);
console.log("\n③の事業所別件数 (上位10):");
for (const [o, c] of [...byOffice.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${o}\t${c}`);

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
console.log(`\n③(bothPresentDiff): ${cat.bothPresentDiff} (基準値 ${baseline.bothPresentDiff})`);

if (UPDATE) {
  baseline.bothPresentDiff = cat.bothPresentDiff;
  baseline.denomCells = denomCells;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  pass(`基準値を更新しました (${cat.bothPresentDiff} / ${denomCells}セル)`);
} else {
  expect(cat.bothPresentDiff <= baseline.bothPresentDiff,
    `③が基準値から増えていない (${cat.bothPresentDiff} <= ${baseline.bothPresentDiff})`);
  if (cat.bothPresentDiff > baseline.bothPresentDiff) {
    console.log("  増えた分の内訳 (原因を確認してから -- --update すること):");
    // baseline実測時に無かった組み合わせを大まかに出す (事業所別件数で比較)
    for (const [o, c] of byOffice) console.log(`    ${o}: ${c}件`);
  }
}

// 後片付け (原本の再抽出結果は使い捨て)
rmSync(EXTRACT_OUT, { recursive: true, force: true });

process.exit(failed === 0 ? 0 : 1);
