"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  Employee,
  Office,
  JobType,
  RoleType,
  SalaryType,
  EmploymentStatus,
} from "@/types/database";

// ─── 定数 ────────────────────────────────────────────────────

const JOB_TYPES: JobType[] = [
  "訪問介護", "訪問入浴", "訪問看護", "居宅介護支援",
  "福祉用具貸与", "薬局", "本社",
];
const ROLE_TYPES: RoleType[] = ["管理者", "提責", "社員", "パート", "事務員"];
const SALARY_TYPES: SalaryType[] = ["月給", "時給"];
const EMPLOYMENT_STATUSES: EmploymentStatus[] = ["在職者", "休職者", "退職者"];

const CSV_HEADERS = [
  "社員番号", "名前", "住所", "事業所番号",
  "在職区分", "入社年月日", "退職年月日", "実勤続月数",
  "職種", "役職", "給与形態",
  "基本給", "固定残業時間", "固定残業代",
  "身体介護時給", "生活援助時給", "訪問型時給",
  "移動手段",
] as const;

// ─── フォーム初期値 ───────────────────────────────────────────

const defaultForm = {
  employee_number: "",
  name: "",
  address: "",
  office_id: "",
  employment_status: "在職者" as EmploymentStatus,
  hire_date: "",
  resignation_date: "",
  effective_service_months: "",
  job_type: "訪問介護" as JobType,
  role_type: "パート" as RoleType,
  salary_type: "時給" as SalaryType,
  base_salary: "",
  fixed_overtime_hours: "",
  fixed_overtime_pay: "",
  hourly_rate_physical: "",
  hourly_rate_living: "",
  hourly_rate_visit: "",
  transport_type: "車",
  has_care_qualification: false,
};

// ─── CSVユーティリティ ────────────────────────────────────────

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === "," && !inQuote) {
      result.push(current); current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCsvText(text: string): string[][] {
  const cleaned = text.replace(/^\uFEFF/, "");
  return cleaned.split(/\r?\n/).filter((l) => l.trim() !== "").map(parseCsvLine);
}

/** 実勤続月数 → "X年Yヶ月" */
function formatMonths(m: number): string {
  if (!m) return "—";
  const y = Math.floor(m / 12);
  const mo = m % 12;
  if (y === 0) return `${mo}ヶ月`;
  if (mo === 0) return `${y}年`;
  return `${y}年${mo}ヶ月`;
}

// ─── インポートプレビュー型 ───────────────────────────────────

type ImportRow = {
  employee_number: string;
  name: string;
  address: string;
  office_number: string;
  employment_status: string;
  hire_date: string;
  resignation_date: string;
  effective_service_months: number;
  job_type: string;
  role_type: string;
  salary_type: string;
  base_salary: number | null;
  fixed_overtime_hours: number | null;
  fixed_overtime_pay: number | null;
  hourly_rate_physical: number | null;
  hourly_rate_living: number | null;
  hourly_rate_visit: number | null;
  transport_type: string;
  error?: string;
};

// ─── メインコンポーネント ─────────────────────────────────────

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [filterStatus, setFilterStatus] = useState<string>("在職者");

  const importRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const fetchData = useCallback(async () => {
    const [empRes, offRes] = await Promise.all([
      supabase.from("employees").select("*").order("employee_number"),
      supabase.from("offices").select("*").order("name"),
    ]);
    if (empRes.data) setEmployees(empRes.data as Employee[]);
    if (offRes.data) setOffices(offRes.data as Office[]);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const resetForm = () => { setForm(defaultForm); setEditingId(null); };

  // ─── 登録・更新 ─────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!form.employee_number || !form.name || !form.office_id) {
      toast.error("社員番号、名前、事業所は必須です");
      return;
    }
    const payload = {
      employee_number: form.employee_number,
      name: form.name,
      address: form.address,
      office_id: form.office_id,
      employment_status: form.employment_status,
      hire_date: form.hire_date || null,
      resignation_date: form.resignation_date || null,
      effective_service_months: form.effective_service_months
        ? parseInt(form.effective_service_months, 10)
        : 0,
      job_type: form.job_type,
      role_type: form.role_type,
      salary_type: form.salary_type,
      base_salary: form.base_salary ? parseInt(form.base_salary, 10) : null,
      fixed_overtime_hours: form.fixed_overtime_hours ? parseFloat(form.fixed_overtime_hours) : null,
      fixed_overtime_pay: form.fixed_overtime_pay ? parseInt(form.fixed_overtime_pay, 10) : null,
      hourly_rate_physical: form.hourly_rate_physical ? parseInt(form.hourly_rate_physical, 10) : null,
      hourly_rate_living: form.hourly_rate_living ? parseInt(form.hourly_rate_living, 10) : null,
      hourly_rate_visit: form.hourly_rate_visit ? parseInt(form.hourly_rate_visit, 10) : null,
      transport_type: form.transport_type,
      has_care_qualification: form.has_care_qualification,
    };

    if (editingId) {
      const { error } = await supabase.from("employees").update(payload).eq("id", editingId);
      if (error) { toast.error(`更新エラー: ${error.message}`); return; }
      toast.success("職員情報を更新しました");
    } else {
      const { error } = await supabase.from("employees").insert(payload);
      if (error) { toast.error(`登録エラー: ${error.message}`); return; }
      toast.success("職員を登録しました");
    }
    setIsOpen(false);
    resetForm();
    fetchData();
  };

  const handleEdit = (emp: Employee) => {
    setForm({
      employee_number: emp.employee_number,
      name: emp.name,
      address: emp.address ?? "",
      office_id: emp.office_id,
      employment_status: emp.employment_status ?? "在職者",
      hire_date: emp.hire_date ?? "",
      resignation_date: emp.resignation_date ?? "",
      effective_service_months: emp.effective_service_months?.toString() ?? "",
      job_type: emp.job_type ?? "訪問介護",
      role_type: emp.role_type,
      salary_type: emp.salary_type,
      base_salary: emp.base_salary?.toString() ?? "",
      fixed_overtime_hours: emp.fixed_overtime_hours?.toString() ?? "",
      fixed_overtime_pay: emp.fixed_overtime_pay?.toString() ?? "",
      hourly_rate_physical: emp.hourly_rate_physical?.toString() ?? "",
      hourly_rate_living: emp.hourly_rate_living?.toString() ?? "",
      hourly_rate_visit: emp.hourly_rate_visit?.toString() ?? "",
      transport_type: emp.transport_type,
      has_care_qualification: emp.has_care_qualification ?? false,
    });
    setEditingId(emp.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この職員を削除しますか？")) return;
    const { error } = await supabase.from("employees").delete().eq("id", id);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success("職員を削除しました");
    fetchData();
  };

  // ─── CSV エクスポート ─────────────────────────────────────────

  const officeMap = new Map(offices.map((o) => [o.id, o]));

  function handleExport() {
    const rows: string[][] = [CSV_HEADERS.slice()];
    for (const emp of employees) {
      const office = officeMap.get(emp.office_id);
      rows.push([
        emp.employee_number,
        emp.name,
        emp.address ?? "",
        office?.office_number ?? "",
        emp.employment_status ?? "在職者",
        emp.hire_date ?? "",
        emp.resignation_date ?? "",
        emp.effective_service_months?.toString() ?? "0",
        emp.job_type ?? "訪問介護",
        emp.role_type,
        emp.salary_type,
        emp.base_salary?.toString() ?? "",
        emp.fixed_overtime_hours?.toString() ?? "",
        emp.fixed_overtime_pay?.toString() ?? "",
        emp.hourly_rate_physical?.toString() ?? "",
        emp.hourly_rate_living?.toString() ?? "",
        emp.hourly_rate_visit?.toString() ?? "",
        emp.transport_type,
      ]);
    }
    downloadCsv("職員一覧.csv", rows);
    toast.success(`${employees.length}件をエクスポートしました`);
  }

  // ─── CSV インポート ───────────────────────────────────────────

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCsvText(text);
      if (rows.length < 2) { toast.error("データ行がありません"); return; }

      const headers = rows[0].map((h) => h.trim());
      const idx = (name: string) => headers.indexOf(name);
      const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));

      const parsed: ImportRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (name: string) => (r[idx(name)] ?? "").trim();
        const empNum = get("社員番号");
        const name = get("名前");
        const officeNum = get("事業所番号");
        if (!empNum || !name) continue;

        const errors: string[] = [];
        if (!officeByNumber.has(officeNum)) errors.push(`事業所番号「${officeNum}」が未登録`);

        const toInt = (s: string) => (s === "" ? null : parseInt(s, 10) || null);
        const toFloat = (s: string) => (s === "" ? null : parseFloat(s) || null);

        parsed.push({
          employee_number: empNum,
          name,
          address: get("住所"),
          office_number: officeNum,
          employment_status: get("在職区分") || "在職者",
          hire_date: get("入社年月日"),
          resignation_date: get("退職年月日"),
          effective_service_months: parseInt(get("実勤続月数") || "0", 10) || 0,
          job_type: get("職種") || "訪問介護",
          role_type: get("役職") || "パート",
          salary_type: get("給与形態") || "時給",
          base_salary: toInt(get("基本給")),
          fixed_overtime_hours: toFloat(get("固定残業時間")),
          fixed_overtime_pay: toInt(get("固定残業代")),
          hourly_rate_physical: toInt(get("身体介護時給")),
          hourly_rate_living: toInt(get("生活援助時給")),
          hourly_rate_visit: toInt(get("訪問型時給")),
          transport_type: get("移動手段") || "車",
          error: errors.length > 0 ? errors.join(" / ") : undefined,
        });
      }

      setImportRows(parsed);
      setImportDialogOpen(true);
      if (importRef.current) importRef.current.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  async function handleImportConfirm() {
    const validRows = importRows.filter((r) => !r.error);
    if (validRows.length === 0) { toast.error("インポートできる行がありません"); return; }

    setImporting(true);
    const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));
    let success = 0;
    let fail = 0;

    for (const row of validRows) {
      const office = officeByNumber.get(row.office_number);
      if (!office) { fail++; continue; }

      const payload = {
        employee_number: row.employee_number,
        name: row.name,
        address: row.address,
        office_id: office.id,
        employment_status: row.employment_status,
        hire_date: row.hire_date || null,
        resignation_date: row.resignation_date || null,
        effective_service_months: row.effective_service_months,
        job_type: row.job_type,
        role_type: row.role_type,
        salary_type: row.salary_type,
        base_salary: row.base_salary,
        fixed_overtime_hours: row.fixed_overtime_hours,
        fixed_overtime_pay: row.fixed_overtime_pay,
        hourly_rate_physical: row.hourly_rate_physical,
        hourly_rate_living: row.hourly_rate_living,
        hourly_rate_visit: row.hourly_rate_visit,
        transport_type: row.transport_type,
      };

      const { error } = await supabase
        .from("employees")
        .upsert(payload, { onConflict: "employee_number,office_id" });

      if (error) fail++;
      else success++;
    }

    setImporting(false);
    setImportDialogOpen(false);
    setImportRows([]);
    fetchData();

    if (fail === 0) toast.success(`${success}件をインポートしました`);
    else toast.warning(`${success}件成功、${fail}件失敗`);
  }

  // ─── フィルタ適用 ─────────────────────────────────────────────

  const filteredEmployees = filterStatus === "全員"
    ? employees
    : employees.filter((e) => (e.employment_status ?? "在職者") === filterStatus);

  // ─── 表示制御 ─────────────────────────────────────────────────

  const showMonthlyFields = form.salary_type === "月給";
  const showFixedOvertimeFields =
    form.role_type === "提責" || form.role_type === "管理者" || form.role_type === "社員";
  const showHourlyRateFields = form.salary_type === "時給";

  // ─── 描画 ─────────────────────────────────────────────────────

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">職員一覧</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport} disabled={employees.length === 0}>
            📥 CSV出力
          </Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>
            📤 CSV取り込み
          </Button>
          <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />

          <Dialog open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger render={<Button />}>新規登録</DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingId ? "職員を編集" : "職員を登録"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {/* 基本情報 */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>社員番号</Label>
                    <Input
                      value={form.employee_number}
                      onChange={(e) => setForm({ ...form, employee_number: e.target.value })}
                      disabled={!!editingId}
                    />
                  </div>
                  <div>
                    <Label>名前</Label>
                    <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                </div>

                <div>
                  <Label>住所</Label>
                  <Input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    placeholder="例: 千葉県長生郡白子町..."
                  />
                </div>

                <div>
                  <Label>所属事業所</Label>
                  <Select
                    value={form.office_id}
                    onValueChange={(v) => setForm({ ...form, office_id: v ?? "" })}
                  >
                    <SelectTrigger><SelectValue placeholder="事業所を選択" /></SelectTrigger>
                    <SelectContent>
                      {offices.map((o) => (
                        <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 在職情報 */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>在職区分</Label>
                    <Select
                      value={form.employment_status}
                      onValueChange={(v) =>
                        setForm({ ...form, employment_status: (v ?? form.employment_status) as EmploymentStatus })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {EMPLOYMENT_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>入社年月日</Label>
                    <Input
                      type="date"
                      value={form.hire_date}
                      onChange={(e) => setForm({ ...form, hire_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>退職年月日</Label>
                    <Input
                      type="date"
                      value={form.resignation_date}
                      onChange={(e) => setForm({ ...form, resignation_date: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <Label>実勤続月数（ヶ月）</Label>
                  <Input
                    type="number"
                    value={form.effective_service_months}
                    onChange={(e) => setForm({ ...form, effective_service_months: e.target.value })}
                    placeholder="例: 120（=10年）"
                  />
                </div>

                {/* 職種・役職・給与形態 */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>職種</Label>
                    <Select
                      value={form.job_type}
                      onValueChange={(v) => setForm({ ...form, job_type: (v ?? form.job_type) as JobType })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {JOB_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>役職</Label>
                    <Select
                      value={form.role_type}
                      onValueChange={(v) => setForm({ ...form, role_type: (v ?? form.role_type) as RoleType })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ROLE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>給与形態</Label>
                    <Select
                      value={form.salary_type}
                      onValueChange={(v) => setForm({ ...form, salary_type: (v ?? form.salary_type) as SalaryType })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SALARY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {showMonthlyFields && (
                  <div>
                    <Label>基本給（月額・円）</Label>
                    <Input
                      type="number"
                      value={form.base_salary}
                      onChange={(e) => setForm({ ...form, base_salary: e.target.value })}
                      placeholder="例: 250000"
                    />
                  </div>
                )}

                {showMonthlyFields && showFixedOvertimeFields && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>固定残業時間（h）</Label>
                      <Input
                        type="number"
                        value={form.fixed_overtime_hours}
                        onChange={(e) => setForm({ ...form, fixed_overtime_hours: e.target.value })}
                        placeholder="例: 30"
                      />
                    </div>
                    <div>
                      <Label>固定残業代（円）</Label>
                      <Input
                        type="number"
                        value={form.fixed_overtime_pay}
                        onChange={(e) => setForm({ ...form, fixed_overtime_pay: e.target.value })}
                        placeholder="例: 50000"
                      />
                    </div>
                  </div>
                )}

                {showHourlyRateFields && (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>身体介護時給</Label>
                      <Input type="number" value={form.hourly_rate_physical}
                        onChange={(e) => setForm({ ...form, hourly_rate_physical: e.target.value })} />
                    </div>
                    <div>
                      <Label>生活援助時給</Label>
                      <Input type="number" value={form.hourly_rate_living}
                        onChange={(e) => setForm({ ...form, hourly_rate_living: e.target.value })} />
                    </div>
                    <div>
                      <Label>訪問型時給</Label>
                      <Input type="number" value={form.hourly_rate_visit}
                        onChange={(e) => setForm({ ...form, hourly_rate_visit: e.target.value })} />
                    </div>
                  </div>
                )}

                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.has_care_qualification}
                      onChange={(e) => setForm({ ...form, has_care_qualification: e.target.checked })}
                    />
                    <span className="text-sm">介護福祉士または実務者研修修了（勤続手当対象）</span>
                  </label>
                </div>

                <div>
                  <Label>移動手段</Label>
                  <Select
                    value={form.transport_type}
                    onValueChange={(v) => setForm({ ...form, transport_type: v ?? form.transport_type })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="車">車</SelectItem>
                      <SelectItem value="自転車">自転車</SelectItem>
                      <SelectItem value="徒歩">徒歩</SelectItem>
                      <SelectItem value="バイク">バイク</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button onClick={handleSubmit} className="w-full">
                  {editingId ? "更新" : "登録"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 在職区分フィルタ */}
      <div className="flex gap-2 mb-4">
        {["在職者", "休職者", "退職者", "全員"].map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1 rounded-full text-sm transition-colors ${
              filterStatus === s
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-muted/80"
            }`}
          >
            {s}
            <span className="ml-1 text-xs opacity-70">
              {s === "全員"
                ? employees.length
                : employees.filter((e) => (e.employment_status ?? "在職者") === s).length}
            </span>
          </button>
        ))}
      </div>

      {/* 職員テーブル */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>社員番号</TableHead>
            <TableHead>名前</TableHead>
            <TableHead>在職区分</TableHead>
            <TableHead>役職</TableHead>
            <TableHead>給与形態</TableHead>
            <TableHead>入社日</TableHead>
            <TableHead>実勤続</TableHead>
            <TableHead>住所</TableHead>
            <TableHead className="w-[100px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredEmployees.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground">
                {filterStatus === "全員" ? "職員が登録されていません" : `${filterStatus}の職員はいません`}
              </TableCell>
            </TableRow>
          ) : (
            filteredEmployees.map((emp) => (
              <TableRow key={emp.id} className={emp.employment_status === "退職者" ? "opacity-50" : ""}>
                <TableCell className="font-mono text-xs">{emp.employee_number}</TableCell>
                <TableCell className="font-medium">{emp.name}</TableCell>
                <TableCell><StatusBadge status={emp.employment_status ?? "在職者"} /></TableCell>
                <TableCell><RoleBadge role={emp.role_type} /></TableCell>
                <TableCell><SalaryBadge type={emp.salary_type} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {emp.hire_date ? emp.hire_date.replace(/-/g, "/") : "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {formatMonths(emp.effective_service_months ?? 0)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                  {emp.address || "—"}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(emp)}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(emp.id)}>削除</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* インポートプレビューダイアログ */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>CSV取り込み確認</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-3">
            {importRows.length}件を読み込みました。エラーのある行はスキップされます。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-muted/50">
                  <th className="border px-2 py-1 text-left">社員番号</th>
                  <th className="border px-2 py-1 text-left">名前</th>
                  <th className="border px-2 py-1 text-left">在職区分</th>
                  <th className="border px-2 py-1 text-left">役職</th>
                  <th className="border px-2 py-1 text-left">入社日</th>
                  <th className="border px-2 py-1 text-left">実勤続月数</th>
                  <th className="border px-2 py-1 text-left">状態</th>
                </tr>
              </thead>
              <tbody>
                {importRows.map((r, i) => (
                  <tr key={i} className={r.error ? "bg-red-50" : ""}>
                    <td className="border px-2 py-1 font-mono">{r.employee_number}</td>
                    <td className="border px-2 py-1">{r.name}</td>
                    <td className="border px-2 py-1">{r.employment_status}</td>
                    <td className="border px-2 py-1">{r.role_type}</td>
                    <td className="border px-2 py-1">{r.hire_date || "—"}</td>
                    <td className="border px-2 py-1">{r.effective_service_months}ヶ月</td>
                    <td className="border px-2 py-1">
                      {r.error
                        ? <span className="text-red-600">⚠ {r.error}</span>
                        : <span className="text-green-600">✓ OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>キャンセル</Button>
            <Button onClick={handleImportConfirm} disabled={importing}>
              {importing ? "取り込み中…" : `取り込み実行（${importRows.filter((r) => !r.error).length}件）`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── バッジ ───────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  在職者: "bg-green-100 text-green-800",
  休職者: "bg-yellow-100 text-yellow-800",
  退職者: "bg-gray-100 text-gray-500",
};
function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{status}</span>;
}

const ROLE_COLORS: Record<string, string> = {
  管理者: "bg-purple-100 text-purple-800",
  提責: "bg-blue-100 text-blue-800",
  社員: "bg-green-100 text-green-800",
  パート: "bg-orange-100 text-orange-800",
  事務員: "bg-gray-100 text-gray-700",
};
function RoleBadge({ role }: { role: string }) {
  const color = ROLE_COLORS[role] ?? "bg-gray-100 text-gray-700";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{role}</span>;
}

function SalaryBadge({ type }: { type: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
      type === "月給" ? "bg-indigo-100 text-indigo-800" : "bg-teal-100 text-teal-800"
    }`}>
      {type}
    </span>
  );
}
