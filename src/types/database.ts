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

export type ImportType = "meisai" | "attendance";

export interface Office {
  id: string;
  office_number: string;
  name: string;
  address: string;
  office_type: OfficeType;
  work_week_start: number;  // 0=日, 1=月, ..., 6=土
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  client_number: string;
  name: string;
  address: string;
  office_id: string;
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
      import_batches: {
        Row: ImportBatch;
        Insert: Omit<ImportBatch, "id" | "created_at">;
        Update: Partial<Omit<ImportBatch, "id" | "created_at">>;
      };
    };
  };
}
