"use client";

import { useState, useEffect, useCallback } from "react";
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
import type { Office, OfficeType, Company } from "@/types/database";

const OFFICE_TYPES: OfficeType[] = [
  "訪問介護",
  "訪問看護",
  "訪問入浴",
  "居宅介護支援",
  "福祉用具貸与",
  "薬局",
  "本社",
];

export default function OfficesPage() {
  const [offices, setOffices] = useState<Office[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    office_number: "",
    name: "",
    short_name: "",
    address: "",
    office_type: "訪問介護" as OfficeType,
    work_week_start: 0,
    travel_unit_price: 0,
    commute_unit_price: 0,
    treatment_subsidy_amount: 0,
    cancel_unit_price: 0,
    travel_allowance_rate: 0,
    communication_fee_amount: 0,
    meeting_unit_price: 0,
    distance_adjustment_rate: 100,
    company_id: "",
  });

  const fetchOffices = useCallback(async () => {
    const { data } = await supabase
      .from("offices")
      .select("*")
      .order("created_at");
    if (data) setOffices(data as Office[]);
  }, []);

  useEffect(() => {
    fetchOffices();
    supabase.from("companies").select("*").order("name").then(({ data }) => {
      if (data) setCompanies(data as Company[]);
    });
  }, [fetchOffices]);

  const resetForm = () => {
    setForm({
      office_number: "",
      name: "",
      short_name: "",
      address: "",
      office_type: "訪問介護",
      work_week_start: 0,
      travel_unit_price: 0,
      commute_unit_price: 0,
      treatment_subsidy_amount: 0,
      cancel_unit_price: 0,
      travel_allowance_rate: 0,
      communication_fee_amount: 0,
      meeting_unit_price: 0,
      distance_adjustment_rate: 100,
      company_id: "",
    });
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!form.office_number || !form.name) {
      toast.error("事業所番号と名称は必須です");
      return;
    }

    if (editingId) {
      const { error } = await supabase
        .from("offices")
        .update({
          name: form.name,
          short_name: form.short_name,
          address: form.address,
          office_type: form.office_type,
          work_week_start: form.work_week_start,
          travel_unit_price: form.travel_unit_price,
          commute_unit_price: form.commute_unit_price,
          treatment_subsidy_amount: form.treatment_subsidy_amount,
          cancel_unit_price: form.cancel_unit_price,
          travel_allowance_rate: form.travel_allowance_rate,
          communication_fee_amount: form.communication_fee_amount,
          meeting_unit_price: form.meeting_unit_price,
          distance_adjustment_rate: form.distance_adjustment_rate,
          company_id: form.company_id || null,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(`更新エラー: ${error.message}`);
        return;
      }
      toast.success("事業所を更新しました");
    } else {
      const { error } = await supabase.from("offices").insert({
        ...form,
        meeting_unit_price: form.meeting_unit_price,
        distance_adjustment_rate: form.distance_adjustment_rate,
        company_id: form.company_id || null,
      });
      if (error) {
        toast.error(`登録エラー: ${error.message}`);
        return;
      }
      toast.success("事業所を登録しました");
    }

    setIsOpen(false);
    resetForm();
    fetchOffices();
  };

  const handleEdit = (office: Office) => {
    setForm({
      office_number: office.office_number,
      name: office.name,
      short_name: office.short_name ?? "",
      address: office.address,
      office_type: office.office_type,
      work_week_start: office.work_week_start ?? 0,
      travel_unit_price: office.travel_unit_price ?? 0,
      commute_unit_price: office.commute_unit_price ?? 0,
      treatment_subsidy_amount: office.treatment_subsidy_amount ?? 0,
      cancel_unit_price: office.cancel_unit_price ?? 0,
      travel_allowance_rate: office.travel_allowance_rate ?? 0,
      communication_fee_amount: office.communication_fee_amount ?? 0,
      meeting_unit_price: office.meeting_unit_price ?? 0,
      distance_adjustment_rate: office.distance_adjustment_rate ?? 100,
      company_id: office.company_id ?? "",
    });
    setEditingId(office.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この事業所を削除しますか？")) return;
    const { error } = await supabase.from("offices").delete().eq("id", id);
    if (error) {
      toast.error(`削除エラー: ${error.message}`);
      return;
    }
    toast.success("事業所を削除しました");
    fetchOffices();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">事業所一覧</h2>
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingId ? "事業所を編集" : "事業所を登録"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>事業所番号</Label>
                <Input
                  value={form.office_number}
                  onChange={(e) =>
                    setForm({ ...form, office_number: e.target.value })
                  }
                  disabled={!!editingId}
                  placeholder="例: 1271500942"
                />
              </div>
              <div>
                <Label>正式名称</Label>
                <Input
                  value={form.name}
                  onChange={(e) =>
                    setForm({ ...form, name: e.target.value })
                  }
                  placeholder="例: リンクスヘルパーステーション茂原"
                />
              </div>
              <div>
                <Label>略称 <span className="text-xs text-muted-foreground font-normal">（システム内の表示名。未設定の場合は正式名称を使用）</span></Label>
                <Input
                  value={form.short_name}
                  onChange={(e) =>
                    setForm({ ...form, short_name: e.target.value })
                  }
                  placeholder="例: 茂原"
                />
              </div>
              <div>
                <Label>住所</Label>
                <Input
                  value={form.address}
                  onChange={(e) =>
                    setForm({ ...form, address: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>事業所種別</Label>
                <Select
                  value={form.office_type}
                  onValueChange={(v) =>
                    setForm({ ...form, office_type: (v ?? form.office_type) as OfficeType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OFFICE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>週起算曜日（残業計算用）</Label>
                <Select
                  value={String(form.work_week_start)}
                  onValueChange={(v) =>
                    setForm({ ...form, work_week_start: parseInt(v ?? "0", 10) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["日", "月", "火", "水", "木", "金", "土"].map((d, i) => (
                      <SelectItem key={i} value={String(i)}>{d}曜日</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>出張手当単価（円/km）</Label>
                <Input
                  type="number" min={0} step={0.01}
                  value={form.travel_unit_price || ""}
                  placeholder="0"
                  onChange={(e) =>
                    setForm({ ...form, travel_unit_price: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>通勤手当単価（円/km）</Label>
                <Input
                  type="number" min={0} step={0.01}
                  value={form.commute_unit_price || ""}
                  placeholder="0"
                  onChange={(e) =>
                    setForm({ ...form, commute_unit_price: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>処遇改善補助金手当（円/月・社保加入者）</Label>
                <Input
                  type="number" min={0}
                  value={form.treatment_subsidy_amount || ""}
                  placeholder="0"
                  onChange={(e) =>
                    setForm({ ...form, treatment_subsidy_amount: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>キャンセル手当単価（円/件）</Label>
                <Input
                  type="number" min={0}
                  value={form.cancel_unit_price || ""}
                  placeholder="0"
                  onChange={(e) =>
                    setForm({ ...form, cancel_unit_price: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>移動手当単価（円/時・訪問介護）</Label>
                <Input
                  type="number" min={0} step={0.01}
                  value={form.travel_allowance_rate || ""}
                  placeholder="0"
                  onChange={(e) =>
                    setForm({ ...form, travel_allowance_rate: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>会議1単価（円/件）</Label>
                <Input
                  type="number" min={0}
                  value={form.meeting_unit_price || ""}
                  placeholder="0"
                  onChange={(e) =>
                    setForm({ ...form, meeting_unit_price: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>距離調整係数（%、例: 125 = 125%）</Label>
                <Input
                  type="number" min={1} step={1}
                  value={form.distance_adjustment_rate || ""}
                  placeholder="100"
                  onChange={(e) =>
                    setForm({ ...form, distance_adjustment_rate: parseFloat(e.target.value) || 100 })
                  }
                />
              </div>
              <div>
                <Label>法人</Label>
                <Select
                  value={form.company_id || "__none__"}
                  onValueChange={(v) => setForm({ ...form, company_id: !v || v === "__none__" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="法人を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未設定</SelectItem>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
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
            <TableHead>事業所番号</TableHead>
            <TableHead>正式名称</TableHead>
            <TableHead>略称</TableHead>
            <TableHead>法人</TableHead>
            <TableHead>種別</TableHead>
            <TableHead>週起算</TableHead>
            <TableHead className="text-right">出張単価</TableHead>
            <TableHead className="text-right">通勤単価</TableHead>
            <TableHead className="text-right">処遇補助金</TableHead>
            <TableHead className="text-right">キャンセル単価</TableHead>
            <TableHead className="text-right">移動手当単価</TableHead>
            <TableHead className="text-right">会議1単価</TableHead>
            <TableHead className="text-right">距離調整係数</TableHead>
            <TableHead>住所</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {offices.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="text-center text-muted-foreground"
              >
                事業所が登録されていません
              </TableCell>
            </TableRow>
          ) : (
            offices.map((office) => (
              <TableRow key={office.id}>
                <TableCell>{office.office_number}</TableCell>
                <TableCell>{office.name}</TableCell>
                <TableCell className="font-medium">{office.short_name || "—"}</TableCell>
                <TableCell className="text-sm">
                  {office.company_id
                    ? (companies.find((c) => c.id === office.company_id)?.name ?? "—")
                    : "—"}
                </TableCell>
                <TableCell>{office.office_type}</TableCell>
                <TableCell>{["日","月","火","水","木","金","土"][office.work_week_start ?? 0]}曜</TableCell>
                <TableCell className="text-right text-sm">
                  {office.travel_unit_price ? `${office.travel_unit_price}円/km` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.commute_unit_price ? `${office.commute_unit_price}円/km` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.treatment_subsidy_amount ? `${office.treatment_subsidy_amount}円` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.cancel_unit_price ? `${office.cancel_unit_price}円/件` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.travel_allowance_rate ? `${office.travel_allowance_rate}円/時` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.meeting_unit_price ? `${office.meeting_unit_price}円/件` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.distance_adjustment_rate != null && office.distance_adjustment_rate !== 100
                    ? `${office.distance_adjustment_rate}%`
                    : "100%"}
                </TableCell>
                <TableCell>{office.address || "-"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(office)}
                    >
                      編集
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(office.id)}
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
