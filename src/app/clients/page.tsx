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
import { GoogleMapPicker } from "@/components/google-map-picker";

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [filterOfficeId, setFilterOfficeId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    client_number: "",
    name: "",
    address: "",
    office_id: "",
    map_latitude: null as number | null,
    map_longitude: null as number | null,
    map_note: "",
  });

  const fetchData = useCallback(async () => {
    // clientsは1000件を超える可能性があるためページング取得
    const pageSize = 1000;
    const allClients: Client[] = [];
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("clients")
        .select("*")
        .order("client_number")
        .range(from, from + pageSize - 1);
      if (!data || data.length === 0) break;
      allClients.push(...(data as Client[]));
      if (data.length < pageSize) break;
      from += pageSize;
    }
    const { data: offData } = await supabase.from("offices").select("*").order("name");
    setClients(allClients);
    if (offData) setOffices(offData as Office[]);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setForm({ client_number: "", name: "", address: "", office_id: "", map_latitude: null, map_longitude: null, map_note: "" });
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
          map_latitude: form.map_latitude,
          map_longitude: form.map_longitude,
          map_note: form.map_note || null,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(`更新エラー: ${error.message}`);
        return;
      }
      toast.success("利用者情報を更新しました");
    } else {
      const { error } = await supabase.from("clients").insert({
        client_number: form.client_number,
        name: form.name,
        address: form.address,
        office_id: form.office_id,
        map_latitude: form.map_latitude,
        map_longitude: form.map_longitude,
        map_note: form.map_note || null,
      });
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
      map_latitude: client.map_latitude,
      map_longitude: client.map_longitude,
      map_note: client.map_note ?? "",
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
      <div className="flex items-center justify-between mb-4">
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
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
                  placeholder="通常の住所（請求書等に使用）"
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
                        {o.short_name || o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* マップ用位置（任意） */}
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-sm">マップ用位置（任意）</Label>
                  {(form.map_latitude !== null || form.map_longitude !== null) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setForm({ ...form, map_latitude: null, map_longitude: null, map_note: "" })}
                    >
                      クリア
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  通常の住所とは別の場所（施設入所中など）の位置を指定する場合に設定。距離計算はここで指定した座標を優先します。
                </p>
                <Input
                  value={form.map_note}
                  onChange={(e) => setForm({ ...form, map_note: e.target.value })}
                  placeholder="メモ（例: 御宿町の特養○○ 101号室）"
                  className="mb-2"
                />
                <GoogleMapPicker
                  latitude={form.map_latitude}
                  longitude={form.map_longitude}
                  fallbackAddress={form.address}
                  onChange={(lat, lng) => setForm({ ...form, map_latitude: lat, map_longitude: lng })}
                />
                {form.map_latitude !== null && form.map_longitude !== null && (
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    緯度: {form.map_latitude.toFixed(6)} / 経度: {form.map_longitude.toFixed(6)}
                  </p>
                )}
              </div>

              <Button onClick={handleSubmit} className="w-full">
                {editingId ? "更新" : "登録"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* 事業所フィルター + 検索 */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label className="text-sm font-medium whitespace-nowrap">事業所</label>
        <Select value={filterOfficeId || "__all__"} onValueChange={(v) => setFilterOfficeId(v === "__all__" ? "" : (v ?? ""))}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">すべて</SelectItem>
            {offices.map((o) => (
              <SelectItem key={o.id} value={o.id}>{o.short_name || o.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="search"
          placeholder="利用者番号 or 名前で検索"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-64"
        />
        <span className="text-sm text-muted-foreground">
          {(() => {
            const q = searchQuery.trim().toLowerCase();
            const matches = clients
              .filter((c) => !filterOfficeId || c.office_id === filterOfficeId)
              .filter((c) => !q || c.client_number.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
            return `${matches.length}名`;
          })()}
        </span>
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
          {(() => {
            const q = searchQuery.trim().toLowerCase();
            const filtered = clients
              .filter((c) => !filterOfficeId || c.office_id === filterOfficeId)
              .filter((c) => !q || c.client_number.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
            if (filtered.length === 0) return (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {clients.length === 0 ? "利用者が登録されていません" : "該当する利用者がいません"}
                </TableCell>
              </TableRow>
            );
            return filtered.map((client) => (
              <TableRow key={client.id}>
                <TableCell>{client.client_number}</TableCell>
                <TableCell>{client.name}</TableCell>
                <TableCell>{client.address || "-"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(client)}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(client.id)}>削除</Button>
                  </div>
                </TableCell>
              </TableRow>
            ));
          })()}
        </TableBody>
      </Table>
    </div>
  );
}
