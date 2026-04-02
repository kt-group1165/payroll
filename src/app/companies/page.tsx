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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { Company } from "@/types/database";

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", address: "", phone: "" });

  const fetchCompanies = useCallback(async () => {
    const { data } = await supabase.from("companies").select("*").order("created_at");
    if (data) setCompanies(data as Company[]);
  }, []);

  useEffect(() => { fetchCompanies(); }, [fetchCompanies]);

  const resetForm = () => {
    setForm({ name: "", address: "", phone: "" });
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!form.name) { toast.error("法人名は必須です"); return; }

    if (editingId) {
      const { error } = await supabase.from("companies").update(form).eq("id", editingId);
      if (error) { toast.error(`更新エラー: ${error.message}`); return; }
      toast.success("法人を更新しました");
    } else {
      const { error } = await supabase.from("companies").insert(form);
      if (error) { toast.error(`登録エラー: ${error.message}`); return; }
      toast.success("法人を登録しました");
    }

    setIsOpen(false);
    resetForm();
    fetchCompanies();
  };

  const handleEdit = (company: Company) => {
    setForm({ name: company.name, address: company.address, phone: company.phone });
    setEditingId(company.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この法人を削除しますか？関連する事業所の法人情報が解除されます。")) return;
    const { error } = await supabase.from("companies").delete().eq("id", id);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success("法人を削除しました");
    fetchCompanies();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">法人一覧</h2>
        <Dialog open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button />}>新規登録</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "法人を編集" : "法人を登録"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>法人名</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例: 株式会社儀八"
                />
              </div>
              <div>
                <Label>住所</Label>
                <Input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div>
                <Label>電話番号</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="例: 0475-00-0000"
                />
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
            <TableHead>法人名</TableHead>
            <TableHead>住所</TableHead>
            <TableHead>電話番号</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {companies.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                法人が登録されていません
              </TableCell>
            </TableRow>
          ) : (
            companies.map((company) => (
              <TableRow key={company.id}>
                <TableCell className="font-medium">{company.name}</TableCell>
                <TableCell>{company.address || "—"}</TableCell>
                <TableCell>{company.phone || "—"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(company)}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(company.id)}>削除</Button>
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
