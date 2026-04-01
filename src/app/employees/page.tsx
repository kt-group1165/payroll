"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import type { Employee, Office, RoleType, SalaryType } from "@/types/database";

const ROLE_TYPES: RoleType[] = [
  "管理者",
  "サービス提供責任者",
  "社員ヘルパー",
  "パートヘルパー",
  "事務員",
];

const SALARY_TYPES: SalaryType[] = ["固定給", "時給"];

const defaultForm = {
  employee_number: "",
  name: "",
  office_id: "",
  role_type: "パートヘルパー" as RoleType,
  salary_type: "時給" as SalaryType,
  base_salary: "",
  fixed_overtime_hours: "",
  fixed_overtime_pay: "",
  hourly_rate_physical: "",
  hourly_rate_living: "",
  hourly_rate_visit: "",
  transport_type: "車",
};

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);

  const fetchData = useCallback(async () => {
    const [empRes, offRes] = await Promise.all([
      supabase.from("employees").select("*").order("employee_number"),
      supabase.from("offices").select("*").order("name"),
    ]);
    if (empRes.data) setEmployees(empRes.data as Employee[]);
    if (offRes.data) setOffices(offRes.data as Office[]);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!form.employee_number || !form.name || !form.office_id) {
      toast.error("社員番号、名前、事業所は必須です");
      return;
    }

    const payload = {
      employee_number: form.employee_number,
      name: form.name,
      office_id: form.office_id,
      role_type: form.role_type,
      salary_type: form.salary_type,
      base_salary: form.base_salary ? parseInt(form.base_salary, 10) : null,
      fixed_overtime_hours: form.fixed_overtime_hours
        ? parseFloat(form.fixed_overtime_hours)
        : null,
      fixed_overtime_pay: form.fixed_overtime_pay
        ? parseInt(form.fixed_overtime_pay, 10)
        : null,
      hourly_rate_physical: form.hourly_rate_physical
        ? parseInt(form.hourly_rate_physical, 10)
        : null,
      hourly_rate_living: form.hourly_rate_living
        ? parseInt(form.hourly_rate_living, 10)
        : null,
      hourly_rate_visit: form.hourly_rate_visit
        ? parseInt(form.hourly_rate_visit, 10)
        : null,
      transport_type: form.transport_type,
    };

    if (editingId) {
      const { error } = await supabase
        .from("employees")
        .update(payload)
        .eq("id", editingId);
      if (error) {
        toast.error(`更新エラー: ${error.message}`);
        return;
      }
      toast.success("職員情報を更新しました");
    } else {
      const { error } = await supabase.from("employees").insert(payload);
      if (error) {
        toast.error(`登録エラー: ${error.message}`);
        return;
      }
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
      office_id: emp.office_id,
      role_type: emp.role_type,
      salary_type: emp.salary_type,
      base_salary: emp.base_salary?.toString() ?? "",
      fixed_overtime_hours: emp.fixed_overtime_hours?.toString() ?? "",
      fixed_overtime_pay: emp.fixed_overtime_pay?.toString() ?? "",
      hourly_rate_physical: emp.hourly_rate_physical?.toString() ?? "",
      hourly_rate_living: emp.hourly_rate_living?.toString() ?? "",
      hourly_rate_visit: emp.hourly_rate_visit?.toString() ?? "",
      transport_type: emp.transport_type,
    });
    setEditingId(emp.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この職員を削除しますか？")) return;
    const { error } = await supabase.from("employees").delete().eq("id", id);
    if (error) {
      toast.error(`削除エラー: ${error.message}`);
      return;
    }
    toast.success("職員を削除しました");
    fetchData();
  };

  const showFixedOvertimeFields =
    form.role_type === "サービス提供責任者" || form.role_type === "管理者";
  const showHourlyRateFields =
    form.role_type === "パートヘルパー" || form.salary_type === "時給";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">職員一覧</h2>
        <Dialog
          open={isOpen}
          onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogTrigger
            render={<Button />}
          >
            新規登録
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingId ? "職員を編集" : "職員を登録"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>社員番号</Label>
                  <Input
                    value={form.employee_number}
                    onChange={(e) =>
                      setForm({ ...form, employee_number: e.target.value })
                    }
                    disabled={!!editingId}
                  />
                </div>
                <div>
                  <Label>名前</Label>
                  <Input
                    value={form.name}
                    onChange={(e) =>
                      setForm({ ...form, name: e.target.value })
                    }
                  />
                </div>
              </div>
              <div>
                <Label>所属事業所</Label>
                <Select
                  value={form.office_id}
                  onValueChange={(v) =>
                    setForm({ ...form, office_id: v ?? "" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="事業所を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {offices.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>職種</Label>
                  <Select
                    value={form.role_type}
                    onValueChange={(v) =>
                      setForm({ ...form, role_type: (v ?? form.role_type) as RoleType })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>給与種別</Label>
                  <Select
                    value={form.salary_type}
                    onValueChange={(v) =>
                      setForm({ ...form, salary_type: (v ?? form.salary_type) as SalaryType })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALARY_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.salary_type === "固定給" && (
                <div>
                  <Label>基本給（月額）</Label>
                  <Input
                    type="number"
                    value={form.base_salary}
                    onChange={(e) =>
                      setForm({ ...form, base_salary: e.target.value })
                    }
                    placeholder="例: 250000"
                  />
                </div>
              )}

              {showFixedOvertimeFields && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>固定残業時間（h）</Label>
                    <Input
                      type="number"
                      value={form.fixed_overtime_hours}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          fixed_overtime_hours: e.target.value,
                        })
                      }
                      placeholder="例: 30"
                    />
                  </div>
                  <div>
                    <Label>固定残業代（円）</Label>
                    <Input
                      type="number"
                      value={form.fixed_overtime_pay}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          fixed_overtime_pay: e.target.value,
                        })
                      }
                      placeholder="例: 50000"
                    />
                  </div>
                </div>
              )}

              {showHourlyRateFields && (
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label>身体介護時給</Label>
                    <Input
                      type="number"
                      value={form.hourly_rate_physical}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          hourly_rate_physical: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label>生活援助時給</Label>
                    <Input
                      type="number"
                      value={form.hourly_rate_living}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          hourly_rate_living: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label>訪問型時給</Label>
                    <Input
                      type="number"
                      value={form.hourly_rate_visit}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          hourly_rate_visit: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>
              )}

              <div>
                <Label>移動手段</Label>
                <Select
                  value={form.transport_type}
                  onValueChange={(v) =>
                    setForm({ ...form, transport_type: v ?? form.transport_type })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>社員番号</TableHead>
            <TableHead>名前</TableHead>
            <TableHead>職種</TableHead>
            <TableHead>給与種別</TableHead>
            <TableHead>移動手段</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {employees.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-center text-muted-foreground"
              >
                職員が登録されていません
              </TableCell>
            </TableRow>
          ) : (
            employees.map((emp) => (
              <TableRow key={emp.id}>
                <TableCell>{emp.employee_number}</TableCell>
                <TableCell>{emp.name}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{emp.role_type}</Badge>
                </TableCell>
                <TableCell>{emp.salary_type}</TableCell>
                <TableCell>{emp.transport_type}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(emp)}
                    >
                      編集
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(emp.id)}
                    >
                      削除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
