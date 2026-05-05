export type OfficeType =
  | "訪問介護"
  | "訪問看護"
  | "訪問入浴"
  | "居宅介護支援"
  | "福祉用具貸与"
  | "薬局"
  | "本社";

/** 職種（どのサービス部門に属するか） */
export type JobType = OfficeType;

/** 役職 */
export type RoleType =
  | "管理者"
  | "提責"
  | "社員"
  | "パート"
  | "事務員";

/** 給与形態 */
export type SalaryType = "月給" | "時給";

export type ImportType = "meisai" | "attendance" | "office_form";

export interface Company {
  id: string;
  /** 共通マスタ companies.id (Phase 3-4a で追加)。法人名/住所/電話の真実は master 側 */
  master_company_id: string | null;
  /** master companies.name from JOIN (Phase 3-4b 以降は post-fetch synthesize) */
  name: string;
  /** master companies.address from JOIN */
  address: string;
  /** master companies.phone from JOIN */
  phone: string;
  /** 請求書差出人情報 (payroll-app 固有) */
  zipcode: string | null;
  formal_name: string | null;
  registration_number: string | null;
  tel: string | null;
  fax: string | null;
  representative: string | null;
  seal_image_url: string | null;
  invoice_greeting: string | null;
  inquiry_tel: string | null;
  created_at: string;
  updated_at: string;
}

export interface Office {
  id: string;
  /** 共通マスタ offices.id (Phase 3-1 で追加)。事業所名/住所の真実は master 側 */
  office_id: string | null;
  office_number: string;
  shogai_office_number: string | null;
  /** master offices.name from JOIN (Phase 3-4b 以降は post-fetch synthesize) */
  name: string;
  short_name: string;
  /** master offices.address from JOIN */
  address: string;
  office_type: OfficeType;
  work_week_start: number;
  travel_unit_price: number;
  commute_unit_price: number;
  treatment_subsidy_amount: number;
  cancel_unit_price: number;
  travel_allowance_rate: number;
  communication_fee_amount: number;
  meeting_unit_price: number;
  distance_adjustment_rate: number;
  company_id: string | null;
  created_at: string;
  updated_at: string;
}

/** SELECT 結果に master JOIN が含まれる shape (post-fetch flatten 前) */
export interface OfficeWithMaster extends Omit<Office, "name" | "address"> {
  master: { name: string; address: string | null } | null;
}
export interface CompanyWithMaster extends Omit<Company, "name" | "address" | "phone"> {
  master: { name: string; address: string | null; phone: string | null } | null;
}

/** payroll_offices SELECT 用の master JOIN clause (Plan B) */
export const OFFICE_MASTER_JOIN = "master:offices!office_id(name, address)";
export const COMPANY_MASTER_JOIN = "master:companies!master_company_id(name, address, phone)";

/** 共通マスタ offices.id を引いて name/address を synthesize する flatten */
export function flattenOfficeMaster<T extends { master?: { name?: string | null; address?: string | null } | null }>(
  rows: T[] | null | undefined,
): (Omit<T, "master"> & { name: string; address: string })[] {
  return (rows ?? []).map(({ master, ...rest }) => ({
    ...(rest as Omit<T, "master">),
    name: master?.name ?? "",
    address: master?.address ?? "",
  }));
}

export function flattenCompanyMaster<T extends { master?: { name?: string | null; address?: string | null; phone?: string | null } | null }>(
  rows: T[] | null | undefined,
): (Omit<T, "master"> & { name: string; address: string; phone: string })[] {
  return (rows ?? []).map(({ master, ...rest }) => ({
    ...(rest as Omit<T, "master">),
    name: master?.name ?? "",
    address: master?.address ?? "",
    phone: master?.phone ?? "",
  }));
}

export type EmploymentStatus = "在職者" | "休職者" | "退職者";

export interface Employee {
  id: string;
  employee_number: string;
  name: string;
  address: string;
  office_id: string;
  job_type: JobType;           // 職種（訪問介護、訪問入浴 等）
  role_type: RoleType;         // 役職（管理者、提責、社員、パート、事務員）
  salary_type: SalaryType;
  employment_status: EmploymentStatus; // 在職区分
  hire_date: string | null;            // 入社年月日
  resignation_date: string | null;     // 退職年月日
  effective_service_months: number;    // 実勤続月数
  base_salary: number | null;
  fixed_overtime_hours: number | null;
  fixed_overtime_pay: number | null;
  hourly_rate_physical: number | null;
  hourly_rate_living: number | null;
  hourly_rate_visit: number | null;
  transport_type: string;
  has_care_qualification: boolean;  // 介護福祉士または実務者研修修了
  social_insurance: boolean;        // 社会保険加入
  paid_leave_unit_price: number;    // 有給手当単価（円/時間）
  communication_fee_type: string;   // 通信費タイプ（none / fixed / variable）
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  /** グループ全体で一意の利用者マスタID（1始まり連番） */
  master_id: number;
  client_number: string;
  name: string;
  address: string;
  office_id: string;
  /** マップ用緯度（設定時はこの座標で距離計算） */
  map_latitude: number | null;
  /** マップ用経度 */
  map_longitude: number | null;
  /** マップ位置のメモ */
  map_note: string | null;
  /** 支払方法: 'withdrawal' | 'transfer' | 'cash' | 'other' */
  payment_method: string | null;
  /** 振替・支払予定日（1〜31） */
  withdrawal_day: number | null;
  /** 口座情報（口座引落時） */
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_type: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  /** 請求書に押印画像を載せるか */
  seal_required: boolean | null;
  /** 居宅介護支援事業者名 */
  care_plan_provider: string | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  company_id: string;
  client_number: string;
  billing_month: string; // YYYYMM
  amount: number;
  paid_at: string;
  method: string | null;
  note: string | null;
  created_at: string;
}

/** ライフサイクル状態 */
export type BillingStatus =
  | "draft"       // 債権発生（提供あり、請求予定未確定）
  | "scheduled"   // 請求予定（CSV取込済、発行前）
  | "invoiced"    // 請求書発行済
  | "paid"        // 入金済
  | "deferred"    // 翌月繰越
  | "cancelled"   // 請求キャンセル
  | "overdue"     // 引落不可・支払遅延
  | "adjustment"; // 過誤調整行

/** billing_amount_items DBレコード (拡張後) */
export interface BillingAmountItemRow {
  id: string;
  segment: "介護" | "障害" | "自費";
  office_number: string | null;
  office_name: string | null;
  client_number: string;
  client_name: string | null;
  billing_month: string;              // 請求月 YYYYMM
  service_month: string;              // サービス提供月 YYYYMM (不変)
  service_item_code: string | null;
  service_item: string | null;
  unit_price: number | null;
  quantity: number | null;
  amount: number;                     // expected_amount相当（CSVから来た予定額）
  invoiced_amount: number | null;     // 請求書記載額
  paid_amount: number | null;         // 実入金額
  tax_amount: number | null;
  reduction_amount: number | null;
  medical_deduction: number | null;
  period_start: string | null;
  period_end: string | null;
  status: string | null;              // CSVの「状態」(確定等)、既存カラム
  billing_status: BillingStatus;      // ライフサイクル
  parent_item_id: string | null;
  actual_issue_date: string | null;
  actual_withdrawal_date: string | null;
  source: "csv" | "manual" | "api";
  lifecycle_note: string | null;
  import_batch_id: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
}

/** 法人ごとの請求書フォーマット設定 */
export interface CompanyInvoiceFormat {
  id: string;
  company_id: string;
  invoice_title: string | null;
  mark_text: string | null;
  greeting: string | null;
  show_bank_account_number: boolean;
  show_bank_account_holder: boolean;
  show_bank_name: boolean;
  show_withdrawal_amount: boolean;
  show_reduction: boolean;
  show_mitigation: boolean;
  show_medical_deduction: boolean;
  show_tax: boolean;
  show_calendar: boolean;
  print_seal: boolean;
  overbilling_text: string | null;
  underbilling_text: string | null;
  offset_remaining_text: string | null;
  inquiry_tel: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceRecord {
  id: string;
  import_batch_id: string;
  office_number: string;
  office_name: string;
  processing_month: string;
  employee_number: string;
  employee_name: string;
  period_start: string;
  period_end: string;
  service_date: string;
  dispatch_start_time: string;
  dispatch_end_time: string;
  client_name: string;
  service_type: string;
  actual_start_time: string;
  actual_end_time: string;
  actual_duration: string;
  calc_start_time: string;
  calc_end_time: string;
  calc_duration: string;
  holiday_type: string;
  time_period: string;
  service_category: string;
  amount: number | null;
  transport_fee: number | null;
  phone_fee: number | null;
  adjustment_fee: number | null;
  meeting_fee: number | null;
  training_fee: number | null;
  other_allowance: number | null;
  total: number | null;
  accompanied_visit: string;
  client_number: string;
  service_code: string;
  created_at: string;
}

export interface AttendanceRecord {
  id: string;
  import_batch_id: string;
  office_number: string;
  employee_number: string;
  employee_name: string;
  year: number;
  month: number;
  day: number;
  day_of_week: string;
  substitute_date: string;
  work_note_1: string;
  work_note_2: string;
  work_note_3: string;
  work_note_4: string;
  work_note_5: string;
  start_time_1: string;
  end_time_1: string;
  start_time_2: string;
  end_time_2: string;
  start_time_3: string;
  end_time_3: string;
  start_time_4: string;
  end_time_4: string;
  start_time_5: string;
  end_time_5: string;
  break_time: string;
  work_hours: string;
  commute_km: number | null;
  business_km: number | null;
  overtime_weekly: string;
  overtime_daily: string;
  holiday_work: string;
  legal_overtime: string;
  deduction: string;
  remarks: string;
  created_at: string;
}

export interface OfficeFormRecord {
  id: string;
  import_batch_id: string;
  office_number: string;
  employee_number: string;
  processing_month: string;
  record_type: "leave" | "training" | "km" | "childcare";
  item_name: string;
  item_date: string | null;
  start_time: string | null;
  end_time: string | null;
  break_time: string | null;
  numeric_value: number | null;
  year_month: string | null;
  child_name: string | null;
  amount: number | null;
  created_at: string;
}

export interface ImportBatch {
  id: string;
  import_type: ImportType;
  file_names: string[];
  record_count: number;
  processing_month: string;
  office_number: string;
  status: "pending" | "completed" | "error";
  error_message: string | null;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: Company;
        Insert: Omit<Company, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Company, "id" | "created_at" | "updated_at">>;
      };
      offices: {
        Row: Office;
        Insert: Omit<Office, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Office, "id" | "created_at" | "updated_at">>;
      };
      employees: {
        Row: Employee;
        Insert: Omit<Employee, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Employee, "id" | "created_at" | "updated_at">>;
      };
      clients: {
        Row: Client;
        Insert: Omit<Client, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Client, "id" | "created_at" | "updated_at">>;
      };
      service_records: {
        Row: ServiceRecord;
        Insert: Omit<ServiceRecord, "id" | "created_at">;
        Update: Partial<Omit<ServiceRecord, "id" | "created_at">>;
      };
      attendance_records: {
        Row: AttendanceRecord;
        Insert: Omit<AttendanceRecord, "id" | "created_at">;
        Update: Partial<Omit<AttendanceRecord, "id" | "created_at">>;
      };
      office_form_records: {
        Row: OfficeFormRecord;
        Insert: Omit<OfficeFormRecord, "id" | "created_at">;
        Update: Partial<Omit<OfficeFormRecord, "id" | "created_at">>;
      };
      import_batches: {
        Row: ImportBatch;
        Insert: Omit<ImportBatch, "id" | "created_at">;
        Update: Partial<Omit<ImportBatch, "id" | "created_at">>;
      };
    };
  };
}
