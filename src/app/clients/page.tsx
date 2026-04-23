"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
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
import dynamic from "next/dynamic";

// クライアント側でのみロード（Google Maps JS APIはwindowが必要）
const GoogleMapPicker = dynamic(
  () => import("@/components/google-map-picker").then((m) => m.GoogleMapPicker),
  { ssr: false, loading: () => <div className="h-[300px] rounded-md border bg-muted animate-pulse" /> }
);

const PAGE_SIZE = 100;

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [filterOfficeId, setFilterOfficeIdRaw] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);

  // URL が /office/[officeNumber]/... の場合、事業所をロック
  const pathname = usePathname();
  const lockedOfficeNumber = useMemo(() => {
    const m = pathname?.match(/^\/office\/([^/]+)\//);
    return m?.[1] ?? null;
  }, [pathname]);
  const lockedOfficeId = useMemo(() => {
    if (!lockedOfficeNumber) return null;
    return offices.find((o) => o.office_number === lockedOfficeNumber)?.id ?? null;
  }, [lockedOfficeNumber, offices]);

  useEffect(() => {
    if (lockedOfficeId && filterOfficeId !== lockedOfficeId) {
      setFilterOfficeIdRaw(lockedOfficeId);
    }
  }, [lockedOfficeId, filterOfficeId]);
  const setFilterOfficeId = (v: string) => {
    if (lockedOfficeId) return;
    setFilterOfficeIdRaw(v);
  };
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
    // 請求情報
    payment_method: "withdrawal",
    withdrawal_day: "" as string,
    bank_name: "",
    bank_branch: "",
    bank_account_type: "普通",
    bank_account_number: "",
    bank_account_holder: "",
    seal_required: false,
    care_plan_provider: "",
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
    setForm({
      client_number: "", name: "", address: "", office_id: lockedOfficeId ?? "",
      map_latitude: null, map_longitude: null, map_note: "",
      payment_method: "withdrawal", withdrawal_day: "",
      bank_name: "", bank_branch: "", bank_account_type: "普通",
      bank_account_number: "", bank_account_holder: "",
      seal_required: false, care_plan_provider: "",
    });
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!form.client_number || !form.name || !form.office_id) {
      toast.error("利用者番号、名前、事業所は必須です");
      return;
    }

    const billingPayload = {
      payment_method: form.payment_method,
      withdrawal_day: form.withdrawal_day ? parseInt(form.withdrawal_day, 10) : null,
      bank_name: form.bank_name || null,
      bank_branch: form.bank_branch || null,
      bank_account_type: form.bank_account_type || null,
      bank_account_number: form.bank_account_number || null,
      bank_account_holder: form.bank_account_holder || null,
      seal_required: form.seal_required,
      care_plan_provider: form.care_plan_provider || null,
    };

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
          ...billingPayload,
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
        ...billingPayload,
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
      payment_method: client.payment_method ?? "withdrawal",
      withdrawal_day: client.withdrawal_day != null ? String(client.withdrawal_day) : "",
      bank_name: client.bank_name ?? "",
      bank_branch: client.bank_branch ?? "",
      bank_account_type: client.bank_account_type ?? "普通",
      bank_account_number: client.bank_account_number ?? "",
      bank_account_holder: client.bank_account_holder ?? "",
      seal_required: client.seal_required ?? false,
      care_plan_provider: client.care_plan_provider ?? "",
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
                  disabled={!!lockedOfficeId}
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

              {/* 請求情報（任意） */}
              <div className="pt-2 border-t">
                <Label className="text-sm">請求情報</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  請求書の作成・入金管理に使用します。
                </p>

                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <Label className="text-xs">支払方法</Label>
                    <select
                      className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                      value={form.payment_method}
                      onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
                    >
                      <option value="withdrawal">口座引落</option>
                      <option value="transfer">振込</option>
                      <option value="cash">集金</option>
                      <option value="other">その他</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">振替/支払日</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={form.withdrawal_day}
                      onChange={(e) => setForm({ ...form, withdrawal_day: e.target.value })}
                      placeholder="27 (1〜31日)"
                    />
                  </div>
                </div>

                {form.payment_method === "withdrawal" && (
                  <div className="space-y-2 mb-3 bg-muted/20 p-3 rounded">
                    <p className="text-xs text-muted-foreground">口座情報</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} placeholder="金融機関（例: 千葉銀行）" />
                      <Input value={form.bank_branch} onChange={(e) => setForm({ ...form, bank_branch: e.target.value })} placeholder="支店名（例: 姉ケ崎）" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        className="border rounded px-2 py-1.5 text-sm bg-background"
                        value={form.bank_account_type}
                        onChange={(e) => setForm({ ...form, bank_account_type: e.target.value })}
                      >
                        <option value="普通">普通</option>
                        <option value="当座">当座</option>
                      </select>
                      <Input
                        className="col-span-2"
                        value={form.bank_account_number}
                        onChange={(e) => setForm({ ...form, bank_account_number: e.target.value })}
                        placeholder="口座番号"
                      />
                    </div>
                    <Input
                      value={form.bank_account_holder}
                      onChange={(e) => setForm({ ...form, bank_account_holder: e.target.value })}
                      placeholder="口座名義人（カナ）"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <div>
                    <Label className="text-xs">居宅介護支援事業者名（任意）</Label>
                    <Input
                      value={form.care_plan_provider}
                      onChange={(e) => setForm({ ...form, care_plan_provider: e.target.value })}
                      placeholder="請求書に表記"
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={form.seal_required}
                      onChange={(e) => setForm({ ...form, seal_required: e.target.checked })}
                    />
                    <span>請求書に押印を表示する（既定はOFF＝押印省略）</span>
                  </label>
                </div>
              </div>

              <Button onClick={handleSubmit} className="w-full">
                {editingId ? "更新" : "登録"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* 事業所フィルター + 検索 */}
      <ClientListView
        clients={clients}
        offices={offices}
        filterOfficeId={filterOfficeId}
        setFilterOfficeId={(v) => { setFilterOfficeId(v); setPage(1); }}
        searchQuery={searchQuery}
        setSearchQuery={(v) => { setSearchQuery(v); setPage(1); }}
        page={page}
        setPage={setPage}
        onEdit={handleEdit}
        onDelete={handleDelete}
        lockedOfficeId={lockedOfficeId}
      />
    </div>
  );
}

// ─── 一覧（useMemoで重いフィルタ・ページングを分離）──────────
function ClientListView({
  clients, offices, filterOfficeId, setFilterOfficeId,
  searchQuery, setSearchQuery, page, setPage, onEdit, onDelete,
  lockedOfficeId,
}: {
  clients: Client[];
  offices: Office[];
  filterOfficeId: string;
  setFilterOfficeId: (v: string) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  page: number;
  setPage: (n: number) => void;
  onEdit: (c: Client) => void;
  onDelete: (id: string) => void;
  lockedOfficeId: string | null;
}) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return clients
      .filter((c) => !filterOfficeId || c.office_id === filterOfficeId)
      .filter((c) => !q || c.client_number.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
  }, [clients, filterOfficeId, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE),
    [filtered, clampedPage]
  );

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label className="text-sm font-medium whitespace-nowrap">事業所</label>
        {lockedOfficeId ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 text-blue-800 px-3 py-1 text-sm">
            🏢 {(() => {
              const o = offices.find((x) => x.id === lockedOfficeId);
              return o ? (o.short_name || o.name) : "—";
            })()}
          </span>
        ) : (
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
        )}
        <Input
          type="search"
          placeholder="利用者番号 or 名前で検索"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-64"
        />
        <span className="text-sm text-muted-foreground">{filtered.length}名</span>
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
          {pageRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                {clients.length === 0 ? "利用者が登録されていません" : "該当する利用者がいません"}
              </TableCell>
            </TableRow>
          ) : (
            pageRows.map((client) => (
              <TableRow key={client.id}>
                <TableCell>{client.client_number}</TableCell>
                <TableCell>{client.name}</TableCell>
                <TableCell>{client.address || "-"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(client)}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => onDelete(client.id)}>削除</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* ページネーション */}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={clampedPage === 1}>«</Button>
          <Button variant="outline" size="sm" onClick={() => setPage(Math.max(1, clampedPage - 1))} disabled={clampedPage === 1}>‹</Button>
          <span className="text-sm text-muted-foreground min-w-[120px] text-center">
            {clampedPage} / {totalPages} ページ
            <span className="ml-2 text-xs">
              ({((clampedPage - 1) * PAGE_SIZE + 1)}〜{Math.min(clampedPage * PAGE_SIZE, filtered.length)}件目)
            </span>
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages, clampedPage + 1))} disabled={clampedPage === totalPages}>›</Button>
          <Button variant="outline" size="sm" onClick={() => setPage(totalPages)} disabled={clampedPage === totalPages}>»</Button>
        </div>
      )}
    </>
  );
}
