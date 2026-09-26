/**
 * 給与計算の結果 (payroll_calc_results) が「その後に変わった入力」より古いかを判定する (2026-09-27)。
 *
 * ★ 「どの表のどの日時列を 計算の入力とみなすか」の定義と判定は ここ 1 か所だけに置く。
 *   scripts/check-calc-freshness.mts が使う。画面 (/verification・/payroll-summary の注意帯) も
 *   作るときはこれを使うこと (同じ定義を 2 か所に書かない)。
 *
 * ⚠ ここは DB を読まない純関数だけ。読むのは呼ぶ側 (script は REST、画面は supabase client)。
 * ⚠ 見えないもの: 行の削除 / created_at しか無い表のその場の書き換え / 計算プログラムの変更 (git。script 側で数える)。
 */

/** 入力の粒度。★ 職員単位・事業所単位の入力は 月を持たないので「その事業所で計算済みの月すべて」に効く扱い */
export type FreshnessLevel = "person_month" | "employee" | "office" | "global";

export type FreshnessSource = {
  table: string;
  /** 比べる日時列 */
  tsCol: "updated_at" | "created_at";
  level: FreshnessLevel;
  /** 読む列 (tsCol を含める) */
  select: string;
  /** 理由の表示名 (行ごとに細かくするときは行を見る) */
  label: (r: Record<string, unknown>) => string;
};

/**
 * 給与計算 (src/app/payroll/page.tsx calculate) が読む入力のうち、日時列で「変わった」が分かるもの。
 * payroll_calc_results.calculated_at より新しい行があれば、その結果は古い。
 */
export const CALC_INPUT_SOURCES: FreshnessSource[] = [
  { table: "payroll_monthly_inputs", tsCol: "updated_at", level: "person_month", select: "office_number,employee_number,processing_month,item_key,updated_at", label: (r) => `monthly_inputs.${r.item_key}` },
  { table: "payroll_office_form_records", tsCol: "created_at", level: "person_month", select: "office_number,employee_number,processing_month,item_name,created_at", label: (r) => `office_form.${r.item_name}` },
  { table: "payroll_attendance_records", tsCol: "created_at", level: "person_month", select: "office_number,employee_number,year,month,created_at", label: () => "attendance_records" },
  { table: "payroll_service_records", tsCol: "created_at", level: "person_month", select: "office_number,employee_number,processing_month,created_at", label: () => "service_records" },
  { table: "payroll_employees", tsCol: "updated_at", level: "employee", select: "id,employee_number,office_id,updated_at", label: () => "payroll_employees" },
  { table: "payroll_salary_settings", tsCol: "updated_at", level: "employee", select: "employee_id,updated_at", label: () => "salary_settings" },
  { table: "payroll_paid_leave_grants", tsCol: "updated_at", level: "employee", select: "employee_id,updated_at", label: () => "paid_leave_grants" },
  { table: "payroll_office_unit_prices", tsCol: "updated_at", level: "office", select: "office_id,effective_from,updated_at", label: () => "office_unit_prices" },
  { table: "payroll_app_settings", tsCol: "updated_at", level: "global", select: "key,updated_at", label: (r) => `app_settings.${r.key}` },
  { table: "payroll_overtime_settings", tsCol: "updated_at", level: "global", select: "id,updated_at", label: () => "overtime_settings" },
  { table: "payroll_category_hourly_rates", tsCol: "updated_at", level: "global", select: "id,updated_at", label: () => "category_hourly_rates" },
];

export type CalcStamp = { office_number: string; processing_month: string; calculated_at: string };
export type EmployeeRef = { office_number: string; employee_number: string };

const normEmp = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");
const monthOf = (r: Record<string, unknown>): string | null => {
  if (typeof r.processing_month === "string") return r.processing_month;
  if (r.year != null && r.month != null) return `${r.year}${String(r.month).padStart(2, "0")}`;
  return null;
};
const monthEndIso = (m: string) => `${m.slice(0, 4)}-${m.slice(4, 6)}-31`;

export type FreshnessResult = {
  /** "事業所|職員番号|月" → 理由 */
  person: Map<string, Set<string>>;
  /** "事業所|月" → 理由 (事業所・全社単位の入力) */
  officeMonth: Map<string, Set<string>>;
};

/**
 * 計算結果ごとに「その後に変わった入力」を集める。
 * @param calc          対象の計算結果 (事業所×月 と calculated_at)
 * @param rowsByTable   CALC_INPUT_SOURCES の table ごとに読んだ行 (★ 呼ぶ側で tsCol > 最も古い calculated_at に絞ってよい)
 * @param employees     職員 id → (事業所番号, 職員番号)。employee 単位の表を 人月に直すのに使う
 * @param officeIdToNumber payroll_offices.id → office_number
 */
export function classifyCalcFreshness(
  calc: CalcStamp[],
  rowsByTable: Map<string, Record<string, unknown>[]>,
  employees: Map<string, EmployeeRef>,
  officeIdToNumber: Map<string, string>,
): FreshnessResult {
  const calcAt = new Map(calc.map((c) => [`${c.office_number}|${c.processing_month}`, c.calculated_at]));
  const monthsOf = new Map<string, string[]>();
  for (const c of calc) monthsOf.set(c.office_number, [...(monthsOf.get(c.office_number) ?? []), c.processing_month]);
  const person = new Map<string, Set<string>>();
  const officeMonth = new Map<string, Set<string>>();
  const addP = (o: string, e: string, m: string, why: string, ts: string) => {
    const at = calcAt.get(`${o}|${m}`); if (!at || ts <= at) return;
    const k = `${o}|${normEmp(e)}|${m}`; if (!person.has(k)) person.set(k, new Set()); person.get(k)!.add(why);
  };
  const addO = (o: string, m: string, why: string, ts: string) => {
    const at = calcAt.get(`${o}|${m}`); if (!at || ts <= at) return;
    const k = `${o}|${m}`; if (!officeMonth.has(k)) officeMonth.set(k, new Set()); officeMonth.get(k)!.add(why);
  };

  for (const src of CALC_INPUT_SOURCES) {
    for (const r of rowsByTable.get(src.table) ?? []) {
      const ts = String(r[src.tsCol] ?? "");
      const why = src.label(r);
      if (src.level === "person_month") {
        const m = monthOf(r); if (!m) continue;
        addP(String(r.office_number), String(r.employee_number), m, why, ts);
      } else if (src.level === "employee") {
        const ref = r.office_id != null
          ? { office_number: officeIdToNumber.get(String(r.office_id)) ?? "", employee_number: String(r.employee_number) }
          : employees.get(String(r.employee_id));
        if (!ref || !ref.office_number) continue;
        for (const m of monthsOf.get(ref.office_number) ?? []) addP(ref.office_number, ref.employee_number, m, why, ts);
      } else if (src.level === "office") {
        const o = officeIdToNumber.get(String(r.office_id)); if (!o) continue;
        // 未来の単価改定は その月の計算には効かないので含めない
        for (const m of monthsOf.get(o) ?? []) if (String(r.effective_from ?? "") <= monthEndIso(m)) addO(o, m, why, ts);
      } else {
        for (const c of calc) addO(c.office_number, c.processing_month, why, ts);
      }
    }
  }
  return { person, officeMonth };
}
