/**
 * check:service-type-mapping — サービスコード → 給与区分 (payroll_service_type_mappings) を サービス名の規則で全数点検する (2026-09-27 給与D)。★ 基準値方式
 *
 *   npm run check:service-type-mapping
 *   npm run check:service-type-mapping -- --update     ★ 基準値を更新 (直して減ったとき / 中身を見たあと)
 *
 * ── なぜ ───────────────────────────────────────────────────────────────
 * 2026-09-27 に 区分の誤りを 1 件ずつ見つけていた (011002 → 010067 → 010044)。どれも 身体介護 と 生活援助 の取り違えで、
 * 身体介護は 1.5h まで身体の時給 (超えた分は生活援助) なので、時給者の小計が 時間 × (身体 − 生活) だけ ずれる
 * (010067: ② との差 4/4 一致 / 010044: 1/1)。1 件ずつ潰すのをやめ、全数を規則で当てる。
 *
 * ── 規則 (名前 = 実績の service_type。無ければ 対応表の service_name) ─────────────────
 *   対象外      自費 / 有料 / 研修 / 会議 / キャンセル / 同行援護 / 重度 / 入浴 (時給が別体系)
 *   生活援助    身無 / 身なし / 身体伴わ / 家事 / 生活援助 / 生N   (ただし 身N生N・身体生活 は除く)
 *   身体介護    身有 / 身あり / 身ｱﾘ / 伴う / 身N / 身体N / 身体介護
 *   身体生活    身N生N / 身体生活 / 身体家事
 *   どれにも当たらない名前 (総合事業 A2xxxx・障害 12xxxx の名前の揺れ 等) は ★ 別掲で件数を出す (分母が見えるように)
 *
 * ── 判定 ─────────────────────────────────────────────────────────────
 *   規則と今の区分が食い違うコードの一覧を基準値と比べる。★ 基準値に無いコードが出たら FAIL。直して消えたら 知らせるだけ
 * 負のコントロール: 写しの 1 件 (規則に当たる一致しているコード) の区分をわざと変えると 食い違いが +1 になること
 * 見ていないもの: 規則に当たらない名前 (別掲の件数) / 時給の額そのもの (payroll_category_hourly_rates) / 月給者
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-service-type-mapping-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type Mapping = { id: string; service_code: string; service_name: string | null; category_id: string };
const maps = await restAll<Mapping>("payroll_service_type_mappings?select=id,service_code,service_name,category_id");
const cats = await restAll<{ id: string; name: string }>("payroll_service_categories?select=id,name");
const catName = new Map(cats.map((c) => [c.id, c.name]));
const recs = await restAll<{ service_code: string; service_type: string | null }>("payroll_service_records?select=id,service_code,service_type");
const used = new Map<string, { names: Set<string>; n: number }>();
for (const r of recs) {
  const x = used.get(r.service_code) ?? { names: new Set<string>(), n: 0 };
  if (r.service_type) x.names.add(r.service_type);
  x.n++;
  used.set(r.service_code, x);
}

export function expectedCategory(name: string): string | null | "対象外" {
  if (/自費|有料|研修|会議|キャンセル|同行援護|重度|入浴/.test(name)) return "対象外";
  if (/身\d+生\d+|身体生活|身体家事/.test(name)) return "身体生活";
  if (/身無|身なし|身体伴わ|身体伴$|家事|生活援助|^生\d/.test(name)) return "生活援助";
  if (/身有|身あり|身ｱﾘ|伴う|^身\d|身体\d|身体介護/.test(name)) return "身体介護";
  return null;
}

type Row = { code: string; name: string; now: string; want: string; n: number };
function check(ms: Mapping[]) {
  const bad: Row[] = []; let outOfScope = 0, noRule = 0, ok = 0;
  const noRuleEx: string[] = [];
  for (const m of ms) {
    const u = used.get(m.service_code);
    const name = [...(u?.names ?? [])][0] ?? m.service_name ?? "";
    const want = expectedCategory(name), now = catName.get(m.category_id) ?? "?";
    if (want === "対象外") { outOfScope++; continue; }
    if (want === null) { noRule++; if (noRuleEx.length < 8) noRuleEx.push(`${m.service_code} ${name || "(名前なし)"} → ${now}`); continue; }
    if (want === now) ok++;
    else bad.push({ code: m.service_code, name, now, want, n: u?.n ?? 0 });
  }
  return { bad, outOfScope, noRule, ok, noRuleEx };
}

console.log("=== check:service-type-mapping (サービスコード → 給与区分 を 名前の規則で全数点検) ===");
const cur = check(maps);
console.log(`母数: 対応 ${maps.length} 件 (実績 ${recs.length} 行)。規則どおり ${cur.ok} / ★ 食い違い ${cur.bad.length} / 対象外 ${cur.outOfScope} / ★ 規則に当たらない (見ていない) ${cur.noRule}`);
for (const b of cur.bad) console.log(`  ★ ${b.code} ${b.name}: 今 ${b.now} / 名前からは ${b.want} (実績 ${b.n} 行)`);
console.log(`  規則に当たらない名前の例: ${cur.noRuleEx.join(" / ")}`);

console.log("\n--- 負のコントロール");
{
  const t = maps.find((m) => { const u = used.get(m.service_code); const nm = [...(u?.names ?? [])][0] ?? m.service_name ?? ""; return expectedCategory(nm) === "生活援助" && catName.get(m.category_id) === "生活援助"; });
  const shintai = cats.find((c) => c.name === "身体介護");
  if (!t || !shintai) expect(false, "壊す元 (規則どおり 生活援助 のコード) が見つからない");
  else {
    const m2 = check(maps.map((m) => (m === t ? { ...m, category_id: shintai.id } : m)));
    expect(m2.bad.length === cur.bad.length + 1, `${t.service_code} をわざと 身体介護 にすると 食い違い +1 (${cur.bad.length} → ${m2.bad.length})`);
  }
}

type Baseline = { _readme: string[]; bad: string[]; noRule: number };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
console.log("\n--- 基準値");
const codes = cur.bad.map((b) => b.code).sort();
if (UPDATE || !baseline) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: baseline?._readme ?? [], bad: codes, noRule: cur.noRule }, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else {
  const added = codes.filter((c) => !baseline.bad.includes(c)), gone = baseline.bad.filter((c) => !codes.includes(c));
  expect(added.length === 0, `基準値に無い食い違い ${added.length} 件${added.length ? `: ${added.join(", ")}  ★ 区分を確かめること` : ""}`);
  if (gone.length) console.log(`  (直って消えた: ${gone.join(", ")}。中身を見て --update)`);
  if (cur.noRule !== baseline.noRule) console.log(`  (規則に当たらない名前 ${baseline.noRule} → ${cur.noRule}。サービスコードが増えた/減った)`);
}
console.log("\n見ていないもの: 規則に当たらない名前 (上の件数) / 時給の額 / 月給者");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
