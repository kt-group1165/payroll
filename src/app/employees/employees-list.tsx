"use client";

import { useState, useRef, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  "移動手段", "介護資格", "社会保険", "有給手当単価",
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
  transport_type: "車",
  has_care_qualification: false,
  social_insurance: false,
  paid_leave_unit_price: "",
  communication_fee_type: "none",
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
  transport_type: string;
  has_care_qualification: boolean;
  social_insurance: boolean;
  paid_leave_unit_price: number;
  communication_fee_type: string;
  error?: string;
};

// ─── メインコンポーネント ─────────────────────────────────────

export function EmployeesList({
  initialEmployees,
  offices,
}: {
  initialEmployees: Employee[];
  offices: Office[];
}) {
  const router = useRouter();
  const employees = initialEmployees;
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [filterStatus, setFilterStatus] = useState<string>("在職者");
  const [filterOfficeIdInternal, setFilterOfficeIdRaw] = useState<string>("");

  // URL が /office/[officeNumber]/... の場合、事業所をロック（選択不可）
  const pathname = usePathname();
  const lockedOfficeNumber = useMemo(() => {
    const m = pathname?.match(/^\/office\/([^/]+)\//);
    return m?.[1] ?? null;
  }, [pathname]);
  const lockedOfficeId = useMemo(() => {
    if (!lockedOfficeNumber) return null;
    return offices.find((o) => o.office_number === lockedOfficeNumber)?.id ?? null;
  }, [lockedOfficeNumber, offices]);

  // ロック中は lockedOfficeId が読み取り値、それ以外は internal state。
  // useEffect での state 同期 (cascading render) を避けるため derived state 化。
  const filterOfficeId = lockedOfficeId ?? filterOfficeIdInternal;
  const setFilterOfficeId = (v: string) => {
    if (lockedOfficeId) return; // ロック中は変更不可
    setFilterOfficeIdRaw(v);
  };

  const importRef = useRef<HTMLInputElement>(null);
  const salarySystemImportRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  // ─── 招待発行 modal state ──────────────────────────────────────
  // payroll_offices.office_id は master offices.id への FK。
  // 招待 API は master offices.id を要求する (consume 時 user_offices.office_id =
  // master id で INSERT されるため)。
  const masterOfficeOptions = useMemo(
    () => offices.filter((o): o is Office & { office_id: string } => !!o.office_id),
    [offices],
  );
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteForm, setInviteForm] = useState<{
    display_name: string;
    login_id: string;
    role: "member" | "office_admin";
    office_id: string;
  }>({
    display_name: "",
    login_id: "",
    role: "member",
    office_id: "",
  });
  const [inviteResult, setInviteResult] = useState<{
    invite_url: string;
    initial_password: string;
    login_id: string | null;
    login_id_was_renamed: boolean;
    expires_at: string | null;
  } | null>(null);
  const [copiedField, setCopiedField] = useState<"url" | "pw" | "id" | null>(null);

  const resetInviteForm = () => {
    setInviteForm({
      display_name: "",
      login_id: "",
      role: "member",
      office_id: "",
    });
    setInviteResult(null);
  };

  const handleInviteSubmit = async () => {
    const displayName = inviteForm.display_name.trim();
    const loginId = inviteForm.login_id.trim().toLowerCase();
    const officeId = inviteForm.office_id;
    if (!displayName) { toast.error("表示名を入力してください"); return; }
    if (!officeId) { toast.error("事業所を選択してください"); return; }

    setInviting(true);
    try {
      const res = await fetch("/api/staff/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: displayName,
          office_id: officeId,
          role: inviteForm.role,
          ...(loginId ? { login_id: loginId } : {}),
        }),
      });
      const json = (await res.json()) as {
        invite_url?: string;
        initial_password?: string;
        login_id?: string | null;
        login_id_was_renamed?: boolean;
        expires_at?: string | null;
        error?: string;
      };
      if (!res.ok) {
        const messages: Record<string, string> = {
          unauthenticated: "ログインセッションが切れました。再ログインしてください。",
          office_not_allowed: "この事業所への招待権限がありません (office_admin 以上が必要)。",
          display_name_invalid: "表示名が不正です (1〜64 文字)。",
          office_id_invalid: "事業所が選択されていません。",
          role_invalid: "ロールが不正です。",
          login_id_invalid: "ログイン ID は英小文字始まり 4〜24 字 (英小・数字・ピリオド・ハイフン) にしてください。",
          login_id_required: "表示名から ID を自動派生できませんでした。ログイン ID を明示的に入力してください。",
          login_id_dedup_exhausted: "同じ login_id が大量に使われていて連番候補を使い切りました。別の base を試してください。",
          insert_failed: "招待の発行に失敗しました (権限不足の可能性)。",
          permission_check_failed: "権限チェックに失敗しました。",
          service_key_missing: "サーバ設定エラー (管理者にお問合せください)。",
          list_users_failed: "既存ユーザーの取得に失敗しました。",
        };
        toast.error(messages[json.error ?? ""] ?? `エラー: ${json.error ?? res.statusText}`);
        return;
      }
      setInviteResult({
        invite_url: json.invite_url ?? "",
        initial_password: json.initial_password ?? "",
        login_id: json.login_id ?? null,
        login_id_was_renamed: !!json.login_id_was_renamed,
        expires_at: json.expires_at ?? null,
      });
      toast.success("招待を発行しました");
    } catch (e) {
      toast.error(`通信エラー: ${e instanceof Error ? e.message : "不明"}`);
    } finally {
      setInviting(false);
    }
  };

  const handleCopy = async (text: string, field: "url" | "pw" | "id") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      toast.error("コピーに失敗しました。手動で選択してください。");
    }
  };

  const resetForm = () => {
    setForm({ ...defaultForm, office_id: lockedOfficeId ?? "" });
    setEditingId(null);
  };

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
      transport_type: form.transport_type,
      has_care_qualification: form.has_care_qualification,
      social_insurance: form.social_insurance,
      paid_leave_unit_price: form.paid_leave_unit_price ? parseFloat(form.paid_leave_unit_price) : 0,
      communication_fee_type: form.communication_fee_type,
    };

    if (editingId) {
      const { error } = await supabase.from("payroll_employees").update(payload).eq("id", editingId);
      if (error) { toast.error(`更新エラー: ${error.message}`); return; }
      toast.success("職員情報を更新しました");
    } else {
      const { error } = await supabase.from("payroll_employees").insert(payload);
      if (error) { toast.error(`登録エラー: ${error.message}`); return; }
      toast.success("職員を登録しました");
    }
    setIsOpen(false);
    resetForm();
    router.refresh();
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
      transport_type: emp.transport_type,
      has_care_qualification: emp.has_care_qualification ?? false,
      social_insurance: emp.social_insurance ?? false,
      paid_leave_unit_price: emp.paid_leave_unit_price?.toString() ?? "",
      communication_fee_type: emp.communication_fee_type ?? "none",
    });
    setEditingId(emp.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この職員を削除しますか？")) return;
    const { error } = await supabase.from("payroll_employees").delete().eq("id", id);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success("職員を削除しました");
    router.refresh();
  };

  // ─── CSV エクスポート ─────────────────────────────────────────

  const officeMap = new Map(offices.map((o) => [o.id, o]));

  function handleExport(targets: Employee[]) {
    const rows: string[][] = [CSV_HEADERS.slice()];
    for (const emp of targets) {
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
        emp.transport_type,
        emp.has_care_qualification ? "1" : "0",
        emp.social_insurance ? "1" : "0",
        emp.paid_leave_unit_price?.toString() ?? "0",
      ]);
    }
    const _fo = officeMap.get(filterOfficeId);
    const officeName = filterOfficeId ? ((_fo?.short_name || _fo?.name) ?? "") : "全事業所";
    downloadCsv(`職員一覧_${officeName}.csv`, rows);
    toast.success(`${targets.length}件をエクスポートしました`);
  }

  // ─── CSV インポート ───────────────────────────────────────────

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buf = ev.target?.result as ArrayBuffer;
      // BOM判定: EF BB BF → UTF-8、それ以外はShift-JISとして試みる
      const bytes = new Uint8Array(buf);
      const isUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      const enc = isUtf8Bom ? "utf-8" : (() => {
        // UTF-8として読んでみて、社員番号ヘッダーが含まれるか確認
        const tryUtf8 = new TextDecoder("utf-8").decode(buf);
        return tryUtf8.includes("社員番号") ? "utf-8" : "shift_jis";
      })();
      const text = new TextDecoder(enc).decode(buf);
      const rows = parseCsvText(text);
      if (rows.length < 2) { toast.error("データ行がありません"); return; }

      const headers = rows[0].map((h) => h.trim());
      const idx = (name: string) => headers.indexOf(name);
      const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));
      const filterOffice = filterOfficeId ? officeMap.get(filterOfficeId) : null;

      const parsed: ImportRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (name: string) => (r[idx(name)] ?? "").trim();
        const empNum = get("社員番号");
        const name = get("名前");
        const officeNum = get("事業所番号");
        if (!empNum || !name) continue;
        // 事業所フィルターが指定されている場合、対象外の行をスキップ
        if (filterOffice && officeNum !== filterOffice.office_number) continue;

        const errors: string[] = [];
        if (!officeByNumber.has(officeNum)) errors.push(`事業所番号「${officeNum}」が未登録`);

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
          transport_type: get("移動手段") || "車",
          has_care_qualification: get("介護資格") === "1",
          social_insurance: get("社会保険") === "1",
          paid_leave_unit_price: parseFloat(get("有給手当単価") || "0") || 0,
          communication_fee_type: get("通信費タイプ") || "none",
          error: errors.length > 0 ? errors.join(" / ") : undefined,
        });
      }

      setImportRows(parsed);
      setImportDialogOpen(true);
      if (importRef.current) importRef.current.value = "";
    };
    reader.readAsArrayBuffer(file);
  }

  // ─── 給与管理システムCSV取り込み ─────────────────────────────
  // 列: 社No, 氏名, フリガナ, 性別, 在職区分, 雇用形態, 生年月日, 入社年月日,
  //      退職年月日, 実勤続月数, 自社勤続月数, グループ勤続月数, スタッフ番号,
  //      住所1, 住所1カナ, 住所2, 住所2カナ, 電話番号, 配信メールアドレス,
  //      備考1, 備考2, 員番号, 会社名, 移動形態, 業種, 備考, 備考

  function handleSalarySystemImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target?.result as ArrayBuffer;
      const text = new TextDecoder("shift_jis").decode(buffer);
      const rows = parseCsvText(text);
      if (rows.length < 2) { toast.error("データ行がありません"); return; }

      // 全角英数字→半角に正規化してからヘッダー比較
      const toHalf = (s: string) =>
        s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF01 + 0x21)).trim();

      const headers = rows[0].map(toHalf);
      const idx = (name: string) => {
        const i = headers.indexOf(name);
        return i;
      };
      const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));


      const JOB_TYPE_MAP: Record<string, JobType> = {
        "ヘルパー": "訪問介護",
        "訪問介護": "訪問介護",
        "訪問看護": "訪問看護",
        "訪問入浴": "訪問入浴",
        "居宅介護支援": "居宅介護支援",
        "福祉用具貸与": "福祉用具貸与",
        "薬局": "薬局",
        "本社": "本社",
      };

      const parsed: ImportRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (name: string) => (r[idx(name)] ?? "").trim();
        // カラム名で取れない場合は位置で取得（フォールバック）
        const empNum  = get("社No")   || (r[0]  ?? "").trim();
        const empName = get("氏名")   || (r[1]  ?? "").trim();
        const officeNum = get("員番号") || (r[21] ?? "").trim();
        if (!empNum || !empName) continue;
        // 外部システムからの取り込みはページフィルターを無視する

        const errors: string[] = [];
        if (!officeByNumber.has(officeNum)) {
          errors.push(`員番号「${officeNum}」が未登録の事業所`);
        }

        // 「支払形態」「雇用形態」どちらの列名でも対応、列5のフォールバックも使用
        // 「支払形態」列を探す（部分一致で文字コードずれに対応）
        const salaryColIdx = headers.findIndex((h) => h.includes("支払"));
        const employmentForm = salaryColIdx >= 0
          ? (r[salaryColIdx] ?? "").trim()
          : get("雇用形態") || (r[5] ?? "").trim();
        const salaryType: SalaryType = employmentForm.includes("月給") ? "月給" : "時給";
        const jobType: JobType = JOB_TYPE_MAP[get("業種") || (r[24] ?? "").trim()] ?? "訪問介護";
        const address = get("住所1") || (r[13] ?? "").trim();
        const employmentStatus = get("在職区分") || (r[4] ?? "").trim() || "在職者";
        const hireDate = get("入社年月日") || (r[7] ?? "").trim();
        const resignationDate = get("退職年月日") || (r[8] ?? "").trim();
        const serviceMonths = parseInt(get("実勤続月数") || (r[9] ?? "0").trim() || "0", 10) || 0;
        const transportType = get("移動形態") || (r[23] ?? "").trim() || "車";

        parsed.push({
          employee_number: empNum,
          name: empName,
          address,
          office_number: officeNum,
          employment_status: employmentStatus,
          hire_date: hireDate,
          resignation_date: resignationDate,
          effective_service_months: serviceMonths,
          job_type: jobType,
          role_type: "パート",
          salary_type: salaryType,
          transport_type: transportType,
          has_care_qualification: false,
          social_insurance: false,
          paid_leave_unit_price: 0,
          communication_fee_type: "none",
          error: errors.length > 0 ? errors.join(" / ") : undefined,
        });
      }

      setImportRows(parsed);
      setImportDialogOpen(true);
      if (salarySystemImportRef.current) salarySystemImportRef.current.value = "";
    };
    reader.readAsArrayBuffer(file);
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
        transport_type: row.transport_type,
        has_care_qualification: row.has_care_qualification,
        social_insurance: row.social_insurance,
        paid_leave_unit_price: row.paid_leave_unit_price,
      };

      const { error } = await supabase
        .from("payroll_employees")
        .upsert(payload, { onConflict: "employee_number,office_id" });

      if (error) fail++;
      else success++;
    }

    setImporting(false);
    setImportDialogOpen(false);
    setImportRows([]);
    router.refresh();

    if (fail === 0) toast.success(`${success}件をインポートしました`);
    else toast.warning(`${success}件成功、${fail}件失敗`);
  }

  // ─── フィルタ・ソート ──────────────────────────────────────────

  type SortKey = "employee_number" | "name" | "employment_status" | "role_type" | "salary_type" | "hire_date" | "effective_service_months" | "address";
  const [sortKey, setSortKey] = useState<SortKey>("employee_number");
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const filteredEmployees = employees
    .filter((e) => filterStatus === "全員" || (e.employment_status ?? "在職者") === filterStatus)
    .filter((e) => !filterOfficeId || e.office_id === filterOfficeId)
    .slice().sort((a, b) => {
    const av = (a[sortKey] ?? "") as string | number;
    const bv = (b[sortKey] ?? "") as string | number;
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv), "ja");
    return sortAsc ? cmp : -cmp;
  });

  // ─── 描画 ─────────────────────────────────────────────────────

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">職員一覧</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => handleExport(filteredEmployees)} disabled={filteredEmployees.length === 0}>
            📥 CSV出力
          </Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>
            📤 CSV取り込み
          </Button>
          <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
          <Button variant="outline" onClick={() => salarySystemImportRef.current?.click()}>
            🏢 給与管理システムから取り込み
          </Button>
          <input ref={salarySystemImportRef} type="file" accept=".csv" className="hidden" onChange={handleSalarySystemImportFile} />

          <Button
            variant="default"
            onClick={() => {
              resetInviteForm();
              setInviteDialogOpen(true);
            }}
          >
            ＋ 招待発行
          </Button>

          <Dialog open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger render={<Button variant="outline" />}>手動追加</DialogTrigger>
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
                  <select
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={form.office_id}
                    onChange={(e) => setForm({ ...form, office_id: e.target.value })}
                    disabled={!!lockedOfficeId}
                  >
                    <option value="">事業所を選択</option>
                    {offices.map((o) => (
                      <option key={o.id} value={o.id}>{o.short_name || o.name}</option>
                    ))}
                  </select>
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

                {/* 給与額 (基本給/固定残業) は payroll_salary_settings (/salary) で per-employee 管理。
                   旧 base_salary / fixed_overtime_* 列は 2026-05-08 削除済 */}

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
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.social_insurance}
                      onChange={(e) => setForm({ ...form, social_insurance: e.target.checked })}
                    />
                    <span className="text-sm">社会保険加入（処遇改善補助金手当対象）</span>
                  </label>
                </div>
                <div>
                  <Label>有給手当単価（円/時間）</Label>
                  <Input
                    type="number" min={0}
                    value={form.paid_leave_unit_price}
                    placeholder="0"
                    onChange={(e) => setForm({ ...form, paid_leave_unit_price: e.target.value })}
                  />
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

      {/* フィルタ */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <div className="flex gap-2">
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
        {lockedOfficeId ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 text-blue-800 px-3 py-1 text-sm">
            🏢 {(() => {
              const o = offices.find((x) => x.id === lockedOfficeId);
              return o ? (o.short_name || o.name) : lockedOfficeNumber;
            })()}
          </span>
        ) : (
          <select
            className="border rounded px-2 py-1 text-sm bg-background"
            value={filterOfficeId}
            onChange={(e) => setFilterOfficeId(e.target.value)}
          >
            <option value="">全事業所</option>
            {offices.map((o) => (
              <option key={o.id} value={o.id}>{o.short_name || o.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* 職員テーブル */}
      <Table>
        <TableHeader>
          <TableRow>
            {(
              [
                { key: "employee_number", label: "社員番号" },
                { key: "name",            label: "名前" },
                { key: "employment_status", label: "在職区分" },
                { key: "role_type",       label: "役職" },
                { key: "salary_type",     label: "給与形態" },
                { key: "hire_date",       label: "入社日" },
                { key: "effective_service_months", label: "実勤続" },
                { key: "address",         label: "住所" },
              ] as { key: SortKey; label: string }[]
            ).map(({ key, label }) => (
              <TableHead
                key={key}
                className="cursor-pointer select-none hover:bg-muted/50"
                onClick={() => handleSort(key)}
              >
                <span className="flex items-center gap-1">
                  {label}
                  {sortKey === key ? (sortAsc ? " ▲" : " ▼") : <span className="text-muted-foreground/30"> ↕</span>}
                </span>
              </TableHead>
            ))}
            <TableHead>事業所</TableHead>
            <TableHead className="w-[100px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredEmployees.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="text-center text-muted-foreground">
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
                <TableCell className="text-sm">
                  {(() => { const _o = officeMap.get(emp.office_id); return (_o?.short_name || _o?.name) ?? "—"; })()}
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

      {/* 招待発行ダイアログ (form / 結果 を 1 枚の modal で兼用) */}
      <Dialog
        open={inviteDialogOpen}
        onOpenChange={(open) => {
          setInviteDialogOpen(open);
          if (!open) resetInviteForm();
        }}
      >
        <DialogContent className="max-w-md">
          {inviteResult ? (
            <>
              <DialogHeader>
                <DialogTitle>招待を発行しました</DialogTitle>
                <DialogDescription>
                  この内容は <strong>このタイミングでしか表示されません</strong>。
                  閉じる前に必ず控えて、招待先に安全な経路 (SMS / 対面 / 紙など) で渡してください。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">招待 URL</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      readOnly
                      value={inviteResult.invite_url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleCopy(inviteResult.invite_url, "url")}
                    >
                      {copiedField === "url" ? "✓" : "コピー"}
                    </Button>
                  </div>
                </div>

                {inviteResult.login_id && (
                  <div>
                    <Label className="text-xs">
                      ログイン ID
                      {inviteResult.login_id_was_renamed && (
                        <span className="ml-2 text-amber-600">(自動リネーム済)</span>
                      )}
                    </Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        readOnly
                        value={inviteResult.login_id}
                        onFocus={(e) => e.currentTarget.select()}
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleCopy(inviteResult.login_id ?? "", "id")}
                      >
                        {copiedField === "id" ? "✓" : "コピー"}
                      </Button>
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs">初期パスワード</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      readOnly
                      value={inviteResult.initial_password}
                      onFocus={(e) => e.currentTarget.select()}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleCopy(inviteResult.initial_password, "pw")}
                    >
                      {copiedField === "pw" ? "✓" : "コピー"}
                    </Button>
                  </div>
                </div>

                {inviteResult.expires_at && (
                  <p className="text-xs text-muted-foreground text-center">
                    有効期限: {new Date(inviteResult.expires_at).toLocaleString("ja-JP")}
                  </p>
                )}

                <Button
                  className="w-full"
                  onClick={() => {
                    setInviteDialogOpen(false);
                    resetInviteForm();
                  }}
                >
                  控えました（閉じる）
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>スタッフを招待</DialogTitle>
                <DialogDescription>
                  招待 URL + 初期パスワード方式 (メール不使用)。発行後、本人に安全な経路で渡してください。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>表示名（必須）</Label>
                  <Input
                    value={inviteForm.display_name}
                    maxLength={64}
                    placeholder="例: 佐藤花子"
                    onChange={(e) => setInviteForm({ ...inviteForm, display_name: e.target.value })}
                  />
                </div>

                <div>
                  <Label>ログイン ID（任意）</Label>
                  <Input
                    value={inviteForm.login_id}
                    maxLength={24}
                    placeholder="例: kawashima  (空欄なら自動)"
                    className="font-mono"
                    onChange={(e) =>
                      setInviteForm({ ...inviteForm, login_id: e.target.value.toLowerCase() })
                    }
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    英小文字始まり 4〜24 字 (英小・数字・ピリオド・ハイフン)。
                    空欄なら表示名から自動派生し、重複時は連番付与。
                  </p>
                </div>

                <div>
                  <Label>所属事業所</Label>
                  <select
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={inviteForm.office_id}
                    onChange={(e) => setInviteForm({ ...inviteForm, office_id: e.target.value })}
                  >
                    <option value="">事業所を選択</option>
                    {masterOfficeOptions.map((o) => (
                      <option key={o.id} value={o.office_id}>
                        {o.short_name || o.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <Label>ロール</Label>
                  <Select
                    value={inviteForm.role}
                    onValueChange={(v) =>
                      setInviteForm({
                        ...inviteForm,
                        role: ((v ?? inviteForm.role) as "member" | "office_admin"),
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">メンバー（現場スタッフ）</SelectItem>
                      <SelectItem value="office_admin">事業所管理者（所長権限）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setInviteDialogOpen(false);
                      resetInviteForm();
                    }}
                  >
                    キャンセル
                  </Button>
                  <Button
                    onClick={handleInviteSubmit}
                    disabled={
                      inviting || !inviteForm.display_name.trim() || !inviteForm.office_id
                    }
                  >
                    {inviting ? "発行中…" : "発行"}
                  </Button>
                </div>
              </div>
            </>
          )}
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
