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
import type { Client, Office } from "@/types/database";

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    client_number: "",
    name: "",
    address: "",
    office_id: "",
  });

  const fetchData = useCallback(async () => {
    const [cliRes, offRes] = await Promise.all([
      supabase.from("clients").select("*").order("client_number"),
      supabase.from("offices").select("*").order("name"),
    ]);
    if (cliRes.data) setClients(cliRes.data as Client[]);
    if (offRes.data) setOffices(offRes.data as Office[]);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setForm({ client_number: "", name: "", address: "", office_id: "" });
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!form.client_number || !form.name || !form.office_id) {
      toast.error("利用者番号、名前、事業所は必須です");
      return;
    }

    if (editingId) {
      const { error } = await supabase
        .from("clients")
        .update({
          name: form.name,
          address: form.address,
          office_id: form.office_id,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(`更新エラー: ${error.message}`);
        return;
      }
      toast.success("利用者情報を更新しました");
    } else {
      const { error } = await supabase.from("clients").insert(form);
      if (error) {
        toast.error(`登録エラー: ${error.message}`);
        return;
      }
      toast.success("利用者を登録しました");
    }

    setIsOpen(false);
    resetForm();
    fetchData();
  };

  const handleEdit = (client: Client) => {
    setForm({
      client_number: client.client_number,
      name: client.name,
      address: client.address,
      office_id: client.office_id,
    });
    setEditingId(client.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この利用者を削除しますか？")) return;
    const { error } = await supabase.from("clients").delete().eq("id", id);
    if (error) {
      toast.error(`削除エラー: ${error.message}`);
      return;
    }
    toast.success("利用者を削除しました");
    fetchData();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">利用者一覧</h2>
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
                {editingId ? "利用者を編集" : "利用者を登録"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>利用者番号</Label>
                <Input
                  value={form.client_number}
                  onChange={(e) =>
                    setForm({ ...form, client_number: e.target.value })
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
              <div>
                <Label>住所</Label>
                <Input
                  value={form.address}
                  onChange={(e) =>
                    setForm({ ...form, address: e.target.value })
                  }
                  placeholder="Google Maps APIでの移動時間算出に使用"
                />
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
            <TableHead>利用者番号</TableHead>
            <TableHead>名前</TableHead>
            <TableHead>住所</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="text-center text-muted-foreground"
              >
                利用者が登録されていません
              </TableCell>
            </TableRow>
          ) : (
            clients.map((client) => (
              <TableRow key={client.id}>
                <TableCell>{client.client_number}</TableCell>
                <TableCell>{client.name}</TableCell>
                <TableCell>{client.address || "-"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(client)}
                    >
                      編集
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(client.id)}
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
