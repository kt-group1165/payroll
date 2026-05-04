// Phase 3-2 cutover: rewrite payroll-app source to address payroll_* prefixed tables in 共通 Supabase.
// Does two transformations:
//   1) `.from("X")` / `.from('X')` / `.from(\`X\`)` → `.from("payroll_X")` (preserves the original quote style).
//   2) Specific helper call sites that pass a literal table name as a positional string arg
//      (fetchAll / fetchAllPages / scan / q / insertAll / fetchCount). Each is rewritten in place.
//
// Run: node scripts/rename_to_payroll_prefix.mjs

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "src");

const TABLES = [
  "attendance_records",
  "billing_amount_items",
  "billing_daily_items",
  "billing_unit_items",
  "category_hourly_rates",
  "clients",
  "companies",
  "company_invoice_formats",
  "distance_cache",
  "employees",
  "import_batches",
  "office_billing_aliases",
  "office_form_records",
  "offices",
  "overtime_settings",
  "payments",
  "salary_settings",
  "service_categories",
  "service_records",
  "service_type_mappings",
];

// Helper functions in payroll-app source that take a table name as their first positional string arg.
// We rewrite the literal at the call site only.
const HELPERS = ["fetchAll", "fetchAllPages", "scan", "q", "insertAll", "fetchCount"];

/** Walk directory recursively, return absolute paths of .ts / .tsx files. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile() && [".ts", ".tsx"].includes(extname(p))) out.push(p);
  }
  return out;
}

function rewriteFromCalls(src) {
  // Match .from(  "X"  )  with any of three quote styles, capturing the quote and the table.
  const re = /\.from\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g;
  let count = 0;
  const out = src.replace(re, (m, quote, name) => {
    if (!TABLES.includes(name)) return m;
    count++;
    return `.from(${quote}payroll_${name}${quote})`;
  });
  return { src: out, count };
}

function rewriteHelperCalls(src) {
  // Match  helperName ( <maybeGenerics> "X"  ...
  // We require the literal to appear as the first arg (after optional type args like <T>).
  // Allow a leading word-boundary so we don't match foo.fetchAll inside object property names.
  let count = 0;
  const helperGroup = HELPERS.join("|");
  const re = new RegExp(
    String.raw`\b(${helperGroup})(\s*<[^>]+>)?(\s*\(\s*)(["'\`])([A-Za-z_][A-Za-z0-9_]*)\4`,
    "g",
  );
  const out = src.replace(re, (m, fn, generics, paren, quote, name) => {
    if (!TABLES.includes(name)) return m;
    count++;
    return `${fn}${generics ?? ""}${paren}${quote}payroll_${name}${quote}`;
  });
  return { src: out, count };
}

let totalFromHits = 0;
let totalHelperHits = 0;
let touchedFiles = 0;

const files = walk(SRC);
for (const f of files) {
  const before = readFileSync(f, "utf8");
  const a = rewriteFromCalls(before);
  const b = rewriteHelperCalls(a.src);
  if (b.src !== before) {
    writeFileSync(f, b.src, "utf8");
    touchedFiles++;
    totalFromHits += a.count;
    totalHelperHits += b.count;
    console.log(
      `[touch] ${f} (.from: ${a.count}, helper-call: ${b.count})`,
    );
  }
}

console.log("---");
console.log(`Files touched: ${touchedFiles}`);
console.log(`.from() rewrites: ${totalFromHits}`);
console.log(`helper-call rewrites: ${totalHelperHits}`);
