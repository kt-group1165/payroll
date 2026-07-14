import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * kaigo-app 実績 → payroll_service_records 変換 (= 直接モードの snapshot pull 本体)
 *
 * 設計 (memory: project_payroll_kaigo_snapshot_pull.md):
 *   - kaigo 側 table を JOIN 直参照せず、取込ボタン押下時にここで rows を組み立てて
 *     CSV 取込と同じ payroll_service_records へコピーする。
 *     下流の給与計算 (/payroll) は取込元を区別せず同一ロジックで動く。
 *   - 取込元:
 *       訪問介護 → kaigo_visit_schedule (status='completed' が実績確定)
 *       訪問入浴 → kaigo_bath_visit_records (status='confirmed'|'submitted' が実績確定)
 *   - 突合キー:
 *       事業所: payroll_offices.office_id = 共通 offices.id = kaigo 側 office_id
 *       職員:   members.name ↔ payroll_employees.name (空白除去 + NFKC 正規化)
 *       利用者: clients.user_number → client_number
 *       サービスコード: service_type → kaigo_service_codes (世代解決 + 全半角ゆれ吸収)
 */

// ── kaigo-app からの移植 helper ──────────────────────────────────
// (kaigo-app/src/lib/service-name-normalize.ts / service-code-valid.ts と同一ロジック)

const Z2H: Record<string, string> = {
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
};
const H2Z: Record<string, string> = {
  "0": "０", "1": "１", "2": "２", "3": "３", "4": "４",
  "5": "５", "6": "６", "7": "７", "8": "８", "9": "９",
};

function toHankakuDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => Z2H[ch] ?? ch);
}
function toZenkakuDigits(s: string): string {
  return s.replace(/[0-9]/g, (ch) => H2Z[ch] ?? ch);
}
function serviceNameVariantsAll(names: string[]): string[] {
  const set = new Set<string>();
  for (const n of names) {
    set.add(n);
    set.add(toZenkakuDigits(n));
    set.add(toHankakuDigits(n));
  }
  return Array.from(set);
}

// ── 型 ────────────────────────────────────────────────────────────

/** payroll_service_records への INSERT payload (import_batch_id は呼び出し側が付与) */
export interface KaigoServiceRecordInsert {
  office_number: string;
  office_name: string;
  processing_month: string; // YYYYMM
  employee_number: string;
  employee_name: string;
  period_start: string;
  period_end: string;
  service_date: string; // YYYY/MM/DD (CSV 取込と同形式)
  dispatch_start_time: string; // HH:MM
  dispatch_end_time: string;
  client_name: string;
  service_type: string;
  actual_start_time: string;
  actual_end_time: string;
  actual_duration: string;
  calc_start_time: string;
  calc_end_time: string;
  calc_duration: string; // "HHH:MM" (例 "000:30")
  holiday_type: string;
  time_period: string;
  service_category: string;
  amount: number | null;
  transport_fee: number | null;
  total: number | null;
  accompanied_visit: string;
  client_number: string;
  service_code: string;
}

export interface SkippedItem {
  reason: string;
  detail: string;
}

export interface KaigoBuildResult {
  rows: KaigoServiceRecordInsert[];
  /** 取込は可能だが確認すべき事項 */
  warnings: string[];
  /** 突合不能などで取込対象から除外した明細 */
  skipped: SkippedItem[];
  /** kaigo 側の対象実績件数 (訪問単位。1 訪問から複数職員行が出る場合あり) */
  sourceCount: number;
  source: string;
}

export interface KaigoPullOffice {
  /** payroll_offices.id */
  payrollOfficeId: string;
  /** payroll_offices.office_number (= offices.business_number) */
  officeNumber: string;
  /** payroll_offices.office_id = 共通 offices.id。null の場合は取込不可 */
  commonOfficeId: string | null;
  officeType: string; // 訪問介護 / 訪問入浴
  officeName: string;
}

// ── 内部 helper ──────────────────────────────────────────────────

/** 氏名突合キー: NFKC 正規化 + 空白 (半角/全角) 全除去 */
function normName(s: string): string {
  return s.normalize("NFKC").replace(/[\s　]+/g, "");
}

/** "HH:MM:SS" | "HH:MM" → "HH:MM" */
function toHM(t: string | null): string {
  if (!t) return "";
  return t.slice(0, 5);
}

/** "HH:MM" 2 つから分数 (不正・逆転は 0) */
function diffMinutes(start: string, end: string): number {
  const p = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  if (!start || !end) return 0;
  const d = p(end) - p(start);
  return d > 0 ? d : 0;
}

/** 分数 → CSV 取込と同じ "HHH:MM" 形式 (例 30 → "000:30") */
function toDurationText(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(3, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → "YYYY/MM/DD" */
function toSlashDate(iso: string): string {
  return iso.replaceAll("-", "/");
}

/** 曜日から休日区分 (祝日は給与計算側が日付から判定するため 平日/土曜/日曜 のみ) */
function holidayTypeOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 ? "日曜" : dow === 6 ? "土曜" : "平日";
}

/** service_type からサービス型 (表示用) を推定 */
function categoryOf(serviceType: string): string {
  const s = toHankakuDigits(serviceType);
  const hasBody = s.includes("身体");
  const hasLife = s.includes("生活") || s.includes("家事");
  if (s.includes("乗降")) return "通院等乗降介助";
  if (hasBody && hasLife) return "身体生活";
  if (hasBody) return "身体介護";
  if (hasLife) return "生活援助";
  return s;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** members.id → 氏名 の解決 */
async function fetchMemberNames(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const c of chunk(ids, 100)) {
    const { data, error } = await supabase.from("members").select("id,name").in("id", c);
    if (error) throw new Error(`members 取得失敗: ${error.message}`);
    for (const m of (data ?? []) as { id: string; name: string }[]) map.set(m.id, m.name);
  }
  return map;
}

/** clients.id → { name, user_number } の解決 */
async function fetchClients(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, { name: string; user_number: string }>> {
  const map = new Map<string, { name: string; user_number: string }>();
  for (const c of chunk(ids, 100)) {
    const { data, error } = await supabase
      .from("clients")
      .select("id,name,user_number")
      .in("id", c);
    if (error) throw new Error(`clients 取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { id: string; name: string; user_number: string | null }[]) {
      map.set(r.id, { name: r.name ?? "", user_number: r.user_number ?? "" });
    }
  }
  return map;
}

interface EmployeeRow {
  employee_number: string;
  name: string;
  office_id: string | null;
  employment_status: string;
}

/**
 * 氏名 → payroll_employees の突合 map。
 * 同名が複数いる場合は 同一事業所所属 > 在職者 の優先で 1 名選ぶ (曖昧なら warning)。
 */
async function buildEmployeeMatcher(
  supabase: SupabaseClient,
  payrollOfficeId: string,
  warnings: string[],
): Promise<(memberName: string) => EmployeeRow | null> {
  const all: EmployeeRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("payroll_employees")
      .select("employee_number,name,office_id,employment_status")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`payroll_employees 取得失敗: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as EmployeeRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }

  const byName = new Map<string, EmployeeRow[]>();
  for (const e of all) {
    const key = normName(e.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(e);
  }

  const warned = new Set<string>();
  return (memberName: string) => {
    const candidates = byName.get(normName(memberName));
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const score = (e: EmployeeRow) =>
      (e.office_id === payrollOfficeId ? 2 : 0) + (e.employment_status === "在職者" ? 1 : 0);
    const sorted = [...candidates].sort((a, b) => score(b) - score(a));
    if (score(sorted[0]) === score(sorted[1]) && !warned.has(memberName)) {
      warned.add(memberName);
      warnings.push(
        `職員「${memberName}」は payroll_employees に同名が ${candidates.length} 名います (職員番号 ${sorted[0].employee_number} を採用)`,
      );
    }
    return sorted[0];
  };
}

/**
 * service_type → 6桁サービスコード の解決 map。
 * kaigo_service_codes を対象月の有効世代で引き、全半角ゆれを吸収。
 * 同名が複数制度にある場合は 介護 > 総合事業 > 独自 > 障害 で採用
 * (kaigo-app visit-seikyu/aggregate.ts と同じ規約)。
 */
async function buildServiceCodeResolver(
  supabase: SupabaseClient,
  serviceTypes: string[],
  year: number,
  month: number,
): Promise<(serviceType: string) => string | null> {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

  const SYSTEM_PRIORITY: Record<string, number> = { 介護: 0, 総合事業: 1, 独自: 2, 障害: 3 };
  const byNorm = new Map<string, { code: string; system: string }>();

  const variants = serviceNameVariantsAll(serviceTypes);
  for (const c of chunk(variants, 50)) {
    const { data, error } = await supabase
      .from("kaigo_service_codes")
      .select("service_name,service_code,system")
      .in("service_name", c)
      .eq("calculation_type", "基本")
      .or(`valid_from.is.null,valid_from.lte.${monthEnd}`)
      .or(`valid_until.is.null,valid_until.gte.${monthStart}`);
    if (error) throw new Error(`kaigo_service_codes 取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_name: string; service_code: string | null; system: string }[]) {
      if (!r.service_code) continue;
      const key = toHankakuDigits(r.service_name);
      const prev = byNorm.get(key);
      if (!prev || (SYSTEM_PRIORITY[r.system] ?? 9) < (SYSTEM_PRIORITY[prev.system] ?? 9)) {
        byNorm.set(key, { code: r.service_code, system: r.system });
      }
    }
  }
  return (serviceType: string) => byNorm.get(toHankakuDigits(serviceType))?.code ?? null;
}

// ── main ─────────────────────────────────────────────────────────

/**
 * 対象月 × 事業所の kaigo 実績を payroll_service_records の行に変換する (INSERT はしない)。
 * @param processingMonth YYYYMM
 */
export async function buildKaigoMeisaiRecords(
  supabase: SupabaseClient,
  office: KaigoPullOffice,
  processingMonth: string,
): Promise<KaigoBuildResult> {
  const year = parseInt(processingMonth.slice(0, 4), 10);
  const month = parseInt(processingMonth.slice(4, 6), 10);
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

  const warnings: string[] = [];
  const skipped: SkippedItem[] = [];

  if (!office.commonOfficeId) {
    throw new Error(
      `事業所「${office.officeName}」に共通マスタ (offices) の紐付けがありません。/offices の「共通マスタから取込」で紐付けてください`,
    );
  }
  const isBath = office.officeType === "訪問入浴";
  const source = isBath ? "kaigo_bath_visit_records" : "kaigo_visit_schedule";
  const matchEmployee = await buildEmployeeMatcher(supabase, office.payrollOfficeId, warnings);

  const rows: KaigoServiceRecordInsert[] = [];
  const base = {
    office_number: office.officeNumber,
    office_name: office.officeName,
    processing_month: processingMonth,
    period_start: toSlashDate(from),
    period_end: toSlashDate(to),
    actual_duration: "",
    amount: null,
    transport_fee: null,
    total: null,
  };

  if (!isBath) {
    // ── 訪問介護: kaigo_visit_schedule (status='completed') ──────
    interface ScheduleRow {
      id: string;
      user_id: string | null;
      staff_id: string | null;
      staff_id_2: string | null;
      staff_id_3: string | null;
      visit_date: string;
      start_time: string | null;
      end_time: string | null;
      service_type: string;
      staff2_start_time: string | null;
      staff2_end_time: string | null;
      staff3_start_time: string | null;
      staff3_end_time: string | null;
    }
    const schedules: ScheduleRow[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select(
          "id,user_id,staff_id,staff_id_2,staff_id_3,visit_date,start_time,end_time,service_type,staff2_start_time,staff2_end_time,staff3_start_time,staff3_end_time",
        )
        .eq("status", "completed")
        .eq("office_id", office.commonOfficeId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("id")
        .range(offset, offset + 999);
      if (error) throw new Error(`kaigo_visit_schedule 取得失敗: ${error.message}`);
      if (!data || data.length === 0) break;
      schedules.push(...(data as ScheduleRow[]));
      if (data.length < 1000) break;
      offset += 1000;
    }

    // office_id 未設定の completed 実績 (移行期データ) は取込対象外 — 件数だけ警告
    {
      const { count, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("id", { count: "exact", head: true })
        .eq("status", "completed")
        .is("office_id", null)
        .gte("visit_date", from)
        .lte("visit_date", to);
      if (!error && (count ?? 0) > 0) {
        warnings.push(
          `office_id 未設定の完了実績が ${count} 件あります (どの事業所か特定できないため取込対象外)`,
        );
      }
    }

    const memberIds = new Set<string>();
    const clientIds = new Set<string>();
    for (const s of schedules) {
      for (const id of [s.staff_id, s.staff_id_2, s.staff_id_3]) if (id) memberIds.add(id);
      if (s.user_id) clientIds.add(s.user_id);
    }
    const [memberNames, clients, resolveCode] = await Promise.all([
      fetchMemberNames(supabase, [...memberIds]),
      fetchClients(supabase, [...clientIds]),
      buildServiceCodeResolver(
        supabase,
        [...new Set(schedules.map((s) => s.service_type))],
        year,
        month,
      ),
    ]);

    const unresolvedTypes = new Set<string>();
    for (const s of schedules) {
      const client = s.user_id ? clients.get(s.user_id) : undefined;
      const code = resolveCode(s.service_type);
      if (!code) unresolvedTypes.add(s.service_type);

      // 1 訪問 × 従事職員 = 1 行 (CSV 明細と同じ粒度)。2/3 人目は各自の時刻を使う
      const slots: { staffId: string | null; st: string; et: string }[] = [
        { staffId: s.staff_id, st: toHM(s.start_time), et: toHM(s.end_time) },
        {
          staffId: s.staff_id_2,
          st: toHM(s.staff2_start_time) || toHM(s.start_time),
          et: toHM(s.staff2_end_time) || toHM(s.end_time),
        },
        {
          staffId: s.staff_id_3,
          st: toHM(s.staff3_start_time) || toHM(s.start_time),
          et: toHM(s.staff3_end_time) || toHM(s.end_time),
        },
      ].filter((x) => x.staffId);

      if (slots.length === 0) {
        skipped.push({
          reason: "担当職員未設定",
          detail: `${toSlashDate(s.visit_date)} ${toHM(s.start_time)} ${client?.name ?? "?"} ${s.service_type}`,
        });
        continue;
      }

      for (const slot of slots) {
        const memberName = memberNames.get(slot.staffId!) ?? "";
        const emp = memberName ? matchEmployee(memberName) : null;
        if (!emp) {
          skipped.push({
            reason: "職員突合不能",
            detail: `${toSlashDate(s.visit_date)} ${slot.st} 「${memberName || slot.staffId}」(payroll_employees に同名なし)`,
          });
          continue;
        }
        const min = diffMinutes(slot.st, slot.et);
        rows.push({
          ...base,
          employee_number: emp.employee_number,
          employee_name: emp.name,
          service_date: toSlashDate(s.visit_date),
          dispatch_start_time: slot.st,
          dispatch_end_time: slot.et,
          client_name: client?.name ?? "",
          client_number: client?.user_number ?? "",
          service_type: s.service_type,
          actual_start_time: slot.st,
          actual_end_time: slot.et,
          calc_start_time: slot.st,
          calc_end_time: slot.et,
          calc_duration: toDurationText(min),
          holiday_type: holidayTypeOf(s.visit_date),
          time_period: "通常",
          service_category: categoryOf(s.service_type),
          accompanied_visit: "",
          service_code: code ?? "",
        });
      }
    }
    if (unresolvedTypes.size > 0) {
      warnings.push(
        `サービスコード未解決: ${[...unresolvedTypes].join(" / ")} (service_code 空で取込。給与カテゴリ判定に使う場合は payroll_service_type_mappings の整備が必要)`,
      );
    }
    return { rows, warnings, skipped, sourceCount: schedules.length, source };
  }

  // ── 訪問入浴: kaigo_bath_visit_records (confirmed / submitted) ──
  interface BathRow {
    id: string;
    client_id: string | null;
    visit_date: string;
    start_time: string | null;
    end_time: string | null;
    bath_type: string | null;
    staff_only: boolean | null;
    service_code: string | null;
    staff_ids: string[] | null;
  }
  const baths: BathRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_bath_visit_records")
      .select("id,client_id,visit_date,start_time,end_time,bath_type,staff_only,service_code,staff_ids")
      .in("status", ["confirmed", "submitted"])
      .eq("office_id", office.commonOfficeId)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("id")
      .range(offset, offset + 999);
    if (error) throw new Error(`kaigo_bath_visit_records 取得失敗: ${error.message}`);
    if (!data || data.length === 0) break;
    baths.push(...(data as BathRow[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  const memberIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const b of baths) {
    for (const id of b.staff_ids ?? []) memberIds.add(id);
    if (b.client_id) clientIds.add(b.client_id);
  }
  const [memberNames, clients] = await Promise.all([
    fetchMemberNames(supabase, [...memberIds]),
    fetchClients(supabase, [...clientIds]),
  ]);

  for (const b of baths) {
    const client = b.client_id ? clients.get(b.client_id) : undefined;
    const serviceType = `訪問入浴 ${b.bath_type ?? ""}${b.staff_only ? " (看護なし)" : ""}`.trim();
    const st = toHM(b.start_time);
    const et = toHM(b.end_time);
    const staffIds = b.staff_ids ?? [];
    if (staffIds.length === 0) {
      skipped.push({
        reason: "従事職員未設定",
        detail: `${toSlashDate(b.visit_date)} ${st} ${client?.name ?? "?"} ${serviceType}`,
      });
      continue;
    }
    for (const staffId of staffIds) {
      const memberName = memberNames.get(staffId) ?? "";
      const emp = memberName ? matchEmployee(memberName) : null;
      if (!emp) {
        skipped.push({
          reason: "職員突合不能",
          detail: `${toSlashDate(b.visit_date)} ${st} 「${memberName || staffId}」(payroll_employees に同名なし)`,
        });
        continue;
      }
      const min = diffMinutes(st, et);
      rows.push({
        ...base,
        employee_number: emp.employee_number,
        employee_name: emp.name,
        service_date: toSlashDate(b.visit_date),
        dispatch_start_time: st,
        dispatch_end_time: et,
        client_name: client?.name ?? "",
        client_number: client?.user_number ?? "",
        service_type: serviceType,
        actual_start_time: st,
        actual_end_time: et,
        calc_start_time: st,
        calc_end_time: et,
        calc_duration: toDurationText(min),
        holiday_type: holidayTypeOf(b.visit_date),
        time_period: "通常",
        service_category: "訪問入浴",
        accompanied_visit: "",
        service_code: b.service_code ?? "",
      });
    }
  }
  return { rows, warnings, skipped, sourceCount: baths.length, source };
}
