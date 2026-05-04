"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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

// ─── CSV ユーティリティ ─────────────────────────────────
const CSV_HEADERS = [
  "内部ID", "利用者番号", "氏名", "住所", "事業所番号", "担当事業所",
  "支払方法", "振替日",
  "金融機関", "支店名", "口座種目", "口座番号", "口座名義人カナ",
  "押印", "居宅介護支援事業者",
  "マップ緯度", "マップ経度", "マップメモ",
] as const;

function downloadCsv(filename: string, rows: string[][]) {
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
  const res: string[] = [];
  let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (ch === "," && !inQ) { res.push(cur); cur = ""; }
    else { cur += ch; }
  }
  res.push(cur);
  return res;
}
function parseCsvText(text: string): string[][] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
}

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
  // 「住所をマップで指定する」チェックでマップ表示切り替え
  const [showMap, setShowMap] = useState(false);
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
    // 1ページ目の clients と offices を並列で取得 → 即UIに反映
    const pageSize = 1000;
    const [first, offRes] = await Promise.all([
      supabase.from("clients").select("*").order("client_number").range(0, pageSize - 1),
      supabase.from("offices").select("*").order("name"),
    ]);
    if (offRes.data) setOffices(offRes.data as Office[]);
    const firstBatch = (first.data ?? []) as Client[];
    setClients(firstBatch);

    // 1000件を超える分は背景で追加取得
    if (firstBatch.length === pageSize) {
      const tail: Client[] = [];
      let from = pageSize;
      while (true) {
        const { data } = await supabase
          .from("clients")
          .select("*")
          .order("client_number")
          .range(from, from + pageSize - 1);
        if (!data || data.length === 0) break;
        tail.push(...(data as Client[]));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (tail.length > 0) setClients((prev) => [...prev, ...tail]);
    }
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
    setShowMap(false);
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
    // 既にマップ位置が登録済みならチェックON
    setShowMap(client.map_latitude != null || client.map_longitude != null);
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

  // ─── CSV 出力 ─────────────────────────────────────────
  const importRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const officeById = new Map(offices.map((o) => [o.id, o]));
    // フィルタ反映: 事業所フィルタ・検索条件を適用
    const q = searchQuery.trim().toLowerCase();
    const targets = clients
      .filter((c) => !filterOfficeId || c.office_id === filterOfficeId)
      .filter((c) => !q || c.client_number.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));

    const rows: string[][] = [CSV_HEADERS.slice()];
    for (const c of targets) {
      const off = officeById.get(c.office_id);
      rows.push([
        String(c.master_id ?? ""),
        c.client_number,
        c.name,
        c.address ?? "",
        off?.office_number ?? "",
        (off?.short_name || off?.name) ?? "",
        c.payment_method ?? "",
        c.withdrawal_day != null ? String(c.withdrawal_day) : "",
        c.bank_name ?? "",
        c.bank_branch ?? "",
        c.bank_account_type ?? "",
        c.bank_account_number ?? "",
        c.bank_account_holder ?? "",
        c.seal_required ? "1" : "0",
        c.care_plan_provider ?? "",
        c.map_latitude != null ? String(c.map_latitude) : "",
        c.map_longitude != null ? String(c.map_longitude) : "",
        c.map_note ?? "",
      ]);
    }
    const _fo = offices.find((o) => o.id === filterOfficeId);
    const label = filterOfficeId ? ((_fo?.short_name || _fo?.name) ?? "") : "全事業所";
    downloadCsv(`利用者一覧_${label}.csv`, rows);
    toast.success(`${targets.length}件をエクスポートしました`);
  };

  // ─── CSV 取り込み ───────────────────────────────────────
  // 内部ID（master_id）をキー:
  //   一致する master_id → UPDATE（上書き）
  //   空欄                → INSERT（新規、master_idは採番される）
  //   存在しない master_id → エラー
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const buf = ev.target?.result as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      const isUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      const enc = isUtf8Bom
        ? "utf-8"
        : (() => {
            const tryUtf8 = new TextDecoder("utf-8").decode(buf);
            return tryUtf8.includes("利用者番号") ? "utf-8" : "shift_jis";
          })();
      const text = new TextDecoder(enc).decode(buf);
      const rows = parseCsvText(text);
      if (rows.length < 2) { toast.error("データ行がありません"); return; }

      const headers = rows[0].map((h) => h.trim());
      const idx = (name: string) => headers.indexOf(name);
      const needs = ["利用者番号", "氏名", "事業所番号"];
      for (const n of needs) if (idx(n) < 0) { toast.error(`ヘッダーに「${n}」が必要です`); return; }

      const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));
      const existingMasterIds = new Set(clients.map((c) => c.master_id));

      const toUpdate: { master_id: number; patch: Record<string, unknown> }[] = [];
      const toInsert: Record<string, unknown>[] = [];
      const errors: string[] = [];

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (name: string) => (r[idx(name)] ?? "").trim();
        const rawMasterId = get("内部ID");
        const clientNumber = get("利用者番号");
        const name = get("氏名");
        const officeNumber = get("事業所番号");
        if (!clientNumber || !name) continue;

        const off = officeByNumber.get(officeNumber);
        if (!off) { errors.push(`行${i + 1}: 事業所番号「${officeNumber}」が未登録`); continue; }

        const payload: Record<string, unknown> = {
          client_number: clientNumber,
          name,
          address: get("住所"),
          office_id: off.id,
          payment_method: get("支払方法") || "withdrawal",
          withdrawal_day: get("振替日") ? parseInt(get("振替日"), 10) || null : null,
          bank_name: get("金融機関") || null,
          bank_branch: get("支店名") || null,
          bank_account_type: get("口座種目") || null,
          bank_account_number: get("口座番号") || null,
          bank_account_holder: get("口座名義人カナ") || null,
          seal_required: get("押印") === "1",
          care_plan_provider: get("居宅介護支援事業者") || null,
          map_latitude: get("マップ緯度") ? parseFloat(get("マップ緯度")) : null,
          map_longitude: get("マップ経度") ? parseFloat(get("マップ経度")) : null,
          map_note: get("マップメモ") || null,
        };

        if (rawMasterId === "") {
          // 新規
          toInsert.push(payload);
        } else {
          const mid = parseInt(rawMasterId, 10);
          if (isNaN(mid)) { errors.push(`行${i + 1}: 内部ID「${rawMasterId}」は数値ではありません`); continue; }
          if (!existingMasterIds.has(mid)) {
            errors.push(`行${i + 1}: 内部ID「${mid}」は存在しません（もともとなかった内部IDが入っています）`);
            continue;
          }
          toUpdate.push({ master_id: mid, patch: payload });
        }
      }

      if (errors.length > 0) {
        toast.error(errors.slice(0, 10).join("\n"));
        if (importRef.current) importRef.current.value = "";
        return;
      }
      if (toUpdate.length === 0 && toInsert.length === 0) {
        toast.error("取り込むデータがありません");
        if (importRef.current) importRef.current.value = "";
        return;
      }
      if (!confirm(`更新${toUpdate.length}件 / 新規${toInsert.length}件 を取り込みますか？`)) {
        if (importRef.current) importRef.current.value = "";
        return;
      }

      let ok = 0; let fail = 0;
      // 更新は個別（バッチupdateはmaster_id違いの複数行を1クエリでできない）
      for (const u of toUpdate) {
        const { error } = await supabase.from("clients").update(u.patch).eq("master_id", u.master_id);
        if (error) { console.error(error); fail++; } else ok++;
      }
      // 新規はまとめてinsert
      if (toInsert.length > 0) {
        const chunkSize = 500;
        for (let i = 0; i < toInsert.length; i += chunkSize) {
          const { error } = await supabase.from("clients").insert(toInsert.slice(i, i + chunkSize));
          if (error) { console.error(error); fail += Math.min(chunkSize, toInsert.length - i); }
          else ok += Math.min(chunkSize, toInsert.length - i);
        }
      }

      if (fail === 0) toast.success(`${ok}件を取り込みました`);
      else toast.warning(`${ok}件成功 / ${fail}件失敗（詳細はコンソール）`);
      fetchData();
      if (importRef.current) importRef.current.value = "";
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">利用者一覧</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExport} disabled={clients.length === 0}>
            📥 CSV出力
          </Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>
            📤 CSV取り込み
          </Button>
          <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
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
          <DialogContent className="w-[96vw] max-h-[92vh] overflow-y-auto" style={{ maxWidth: showMap ? "1400px" : "1000px" }}>
            <DialogHeader>
              <DialogTitle>
                {editingId ? "利用者を編集" : "利用者を登録"}
              </DialogTitle>
            </DialogHeader>
            {/* 2 or 3カラム: 基本情報 / [マップ] / 請求情報 */}
            <div className={`grid grid-cols-1 md:grid-cols-2 ${showMap ? "lg:grid-cols-[1fr_1fr_1.2fr]" : "lg:grid-cols-[1fr_1.2fr]"} gap-4`}>
              {/* ── 左カラム: 基本情報 ─────────────────── */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
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
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="事業所を選択">
                        {(v: string) => {
                          const o = offices.find((x) => x.id === v);
                          return o ? (o.short_name || o.name) : "事業所を選択";
                        }}
                      </SelectValue>
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
                <div>
                  <Label>住所</Label>
                  <Input
                    value={form.address}
                    onChange={(e) =>
                      setForm({ ...form, address: e.target.value })
                    }
                    placeholder="通常の住所（請求書等に使用）"
                  />
                  <label className="flex items-center gap-2 mt-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showMap}
                      onChange={(e) => setShowMap(e.target.checked)}
                    />
                    <span>住所をマップで指定する（施設入所中など、住所と実位置が異なる場合）</span>
                  </label>
                </div>
              </div>

              {/* ── 中央カラム: マップ (showMap が true の時のみ表示) ─────────────── */}
              {showMap && (
              <div className="space-y-3">
                <div>
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
                    距離計算はここで指定した座標を優先します。
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
              </div>
              )}

              {/* ── 右カラム: 請求情報 ─────────────── */}
              <div className="space-y-3">
                <div>
                  <Label className="text-sm">請求情報</Label>
                  <p className="text-xs text-muted-foreground">
                    請求書の作成・入金管理に使用します。
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
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
                  <div className="space-y-2 bg-muted/20 p-3 rounded">
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

            <Button onClick={handleSubmit} className="w-full mt-4">
              {editingId ? "更新" : "登録"}
            </Button>
          </DialogContent>
        </Dialog>
        </div>
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
              <SelectValue>
                {(v: string) => {
                  if (!v || v === "__all__") return "すべて";
                  const o = offices.find((x) => x.id === v);
                  return o ? (o.short_name || o.name) : "すべて";
                }}
              </SelectValue>
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
            <TableHead>事業所</TableHead>
            <TableHead>住所</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {clients.length === 0 ? "利用者が登録されていません" : "該当する利用者がいません"}
              </TableCell>
            </TableRow>
          ) : (
            pageRows.map((client) => {
              const office = offices.find((o) => o.id === client.office_id);
              return (
                <TableRow key={client.id}>
                  <TableCell>{client.client_number}</TableCell>
                  <TableCell>{client.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {office ? (office.short_name || office.name) : "—"}
                  </TableCell>
                  <TableCell>{client.address || "-"}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onEdit(client)}>編集</Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(client.id)}>削除</Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
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
