"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

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

export interface ServiceCategory {
  id: string;
  name: string;
  sort_order: number;
}

export interface ServiceTypeMapping {
  id: string;
  service_code: string;
  service_name: string;
  category_id: string;
  service_categories?: { name: string };
}

export interface UnmappedService {
  service_code: string;
  service_name: string;
}

export interface CategoryHourlyRate {
  id: string;
  office_id: string;
  category_id: string;
  hourly_rate: number;
  /** この日 (月初) からの時給。2000-01-01 = 履歴を持つ前からの値 (2026-09-22) */
  effective_from?: string | null;
  /** payroll_offices.short_name + master offices.name via nested JOIN */
  offices?: { short_name: string; master?: { name: string } | null };
  service_categories?: { name: string };
}

export interface Office {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
}

// ====================
// 類型管理タブ
// ====================
function CategoriesTab({ initialCategories }: { initialCategories: ServiceCategory[] }) {
  const router = useRouter();
  const categories = initialCategories;
  const [isOpen, setIsOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const fetch = useCallback(() => router.refresh(), [router]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    const maxOrder = categories.reduce(
      (max, c) => Math.max(max, c.sort_order),
      0
    );
    const { error } = await supabase
      .from("payroll_service_categories")
      .insert({ name: newName.trim(), sort_order: maxOrder + 1 });
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("類型を追加しました");
    setNewName("");
    setIsOpen(false);
    fetch();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この類型を削除しますか？関連するマッピングと時給設定も削除されます。"))
      return;
    const { error } = await supabase
      .from("payroll_service_categories")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    fetch();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          サービスの大分類を管理します
        </p>
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger render={<Button />}>類型を追加</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>サービス類型を追加</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>類型名</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例: 身体介護"
                />
              </div>
              <Button onClick={handleAdd} className="w-full">
                追加
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>類型名</TableHead>
            <TableHead className="w-[80px]">表示順</TableHead>
            <TableHead className="w-[80px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {categories.map((cat) => (
            <TableRow key={cat.id}>
              <TableCell>{cat.name}</TableCell>
              <TableCell>{cat.sort_order}</TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(cat.id)}
                >
                  削除
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ====================
// マッピングタブ
// ====================
function MappingsTab({
  initialMappings,
  initialCategories,
}: {
  initialMappings: ServiceTypeMapping[];
  initialCategories: ServiceCategory[];
}) {
  const router = useRouter();
  const mappings = initialMappings;
  const categories = initialCategories;
  // 未マッピング集計は重い (service_records 全件 scan) ため client 側で lazy fetch。
  // 初回 SSR を高速化する。
  const [unmapped, setUnmapped] = useState<UnmappedService[]>([]);
  const [unmappedLoading, setUnmappedLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mappedCodes = new Set(mappings.map((m) => m.service_code));
      const codeNameMap = new Map<string, string>();
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("payroll_service_records")
          .select("service_code,service_type")
          .order("id")
          .range(from, from + pageSize - 1);
        if (cancelled) return;
        if (!data || data.length === 0) break;
        for (const r of data) {
          const row = r as { service_code: string; service_type: string };
          const code = row.service_code;
          const name = row.service_type;
          if (code && code.trim() && !codeNameMap.has(code)) {
            codeNameMap.set(code, name || "");
          }
        }
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (cancelled) return;
      const result: UnmappedService[] = [];
      for (const [code, name] of codeNameMap) {
        if (!mappedCodes.has(code)) {
          result.push({ service_code: code, service_name: name });
        }
      }
      result.sort((a, b) => a.service_code.localeCompare(b.service_code));
      setUnmapped(result);
      setUnmappedLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mappings]);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({
    service_code: "",
    service_name: "",
    category_id: "",
  });
  const importInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.value = "";
  }, []);

  const fetchData = useCallback(() => router.refresh(), [router]);

  const handleAdd = async () => {
    if (!form.service_code || !form.category_id) {
      toast.error("サービスコードと類型を入力してください");
      return;
    }
    const { error } = await supabase.from("payroll_service_type_mappings").insert({
      service_code: form.service_code,
      service_name: form.service_name,
      category_id: form.category_id,
    });
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("マッピングを追加しました");
    setForm({ service_code: "", service_name: "", category_id: "" });
    setIsOpen(false);
    fetchData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このマッピングを削除しますか？")) return;
    const { error } = await supabase
      .from("payroll_service_type_mappings")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    fetchData();
  };

  const handleQuickMap = async (svc: UnmappedService, categoryId: string) => {
    const { error } = await supabase.from("payroll_service_type_mappings").insert({
      service_code: svc.service_code,
      service_name: svc.service_name,
      category_id: categoryId,
    });
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success(`${svc.service_code} をマッピングしました`);
    fetchData();
  };

  // CSVエクスポート（マッピング済み＋未マッピングを含む）
  const handleExport = () => {
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const header = "サービスコード,サービス名,類型\n";
    const mappedRows = mappings.map(
      (m) =>
        `${m.service_code},${m.service_name},${categoryMap.get(m.category_id) || ""}`
    );
    const unmappedRows = unmapped.map(
      (u) => `${u.service_code},${u.service_name},`
    );
    const rows = [...mappedRows, ...unmappedRows].join("\n");
    const bom = "\uFEFF";
    const blob = new Blob([bom + header + rows], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "service_mappings.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // CSVインポート（上書き）
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l);

    // ヘッダ行をスキップ
    const dataLines = lines.slice(1);
    if (dataLines.length === 0) {
      toast.error("データ行がありません");
      return;
    }

    // 類型名→IDのマップ
    const categoryNameMap = new Map(categories.map((c) => [c.name, c.id]));

    const newMappings: {
      service_code: string;
      service_name: string;
      category_id: string;
    }[] = [];
    const errors: string[] = [];

    for (let i = 0; i < dataLines.length; i++) {
      const cols = dataLines[i].split(",");
      if (cols.length < 3) {
        errors.push(`行${i + 2}: カラム数が不足`);
        continue;
      }
      const code = cols[0].trim();
      const name = cols[1].trim();
      const catName = cols[2].trim();
      const catId = categoryNameMap.get(catName);
      if (!catId) {
        errors.push(`行${i + 2}: 類型「${catName}」が見つかりません`);
        continue;
      }
      newMappings.push({
        service_code: code,
        service_name: name,
        category_id: catId,
      });
    }

    if (errors.length > 0) {
      toast.error(errors.join("\n"));
      return;
    }

    // サービスコード重複を排除（最後の値を採用）+ 重複件数を通知
    const dedupMap = new Map<string, typeof newMappings[number]>();
    const duplicateCodes = new Set<string>();
    for (const m of newMappings) {
      if (dedupMap.has(m.service_code)) duplicateCodes.add(m.service_code);
      dedupMap.set(m.service_code, m);
    }
    const dedupedMappings = Array.from(dedupMap.values());
    const dupMsg = duplicateCodes.size > 0
      ? `\nサービスコード重複${duplicateCodes.size}件は後勝ちで統合（例: ${[...duplicateCodes].slice(0, 3).join(", ")}）`
      : "";

    if (
      !confirm(
        `既存のマッピングを全て削除して、${dedupedMappings.length}件で上書きしますか？${dupMsg}`
      )
    )
      return;

    // 全削除して再挿入
    const { error: deleteError } = await supabase
      .from("payroll_service_type_mappings")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (deleteError) {
      toast.error(`既存マッピングの削除に失敗しました: ${deleteError.message}`);
      return;
    }

    const { error } = await supabase
      .from("payroll_service_type_mappings")
      .insert(dedupedMappings);
    if (error) {
      toast.error(`インポートエラー: ${error.message}`);
      return;
    }
    toast.success(`${dedupedMappings.length}件のマッピングをインポートしました`);
    fetchData();
    // inputをリセット
    e.target.value = "";
  };

  return (
    <div className="space-y-4">
      {/* 未マッピング警告 (client-side lazy fetch) */}
      {unmappedLoading && (
        <div className="border border-muted bg-muted/30 rounded-md p-3 text-sm text-muted-foreground">
          未マッピングコードを集計中…
        </div>
      )}
      {!unmappedLoading && unmapped.length > 0 && (
        <div className="border border-orange-200 bg-orange-50 rounded-md p-4 space-y-3">
          <p className="text-sm font-medium">
            未マッピングのサービスコードが {unmapped.length} 件あります
          </p>
          {unmapped.map((svc) => (
            <div key={svc.service_code} className="flex items-center gap-2">
              <Badge variant="secondary" className="font-mono">
                {svc.service_code}
              </Badge>
              <span className="text-sm text-muted-foreground min-w-[100px]">
                {svc.service_name}
              </span>
              <Select
                onValueChange={(v) => {
                  if (v && typeof v === "string") handleQuickMap(svc, v);
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="類型を選択">
                    {(v: string) => {
                      const c = categories.find((x) => x.id === v);
                      return c ? c.name : "類型を選択";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          サービスコードと類型の紐付けを管理します
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport}>
            CSVエクスポート
          </Button>
          <label>
            <Button
              variant="outline"
              onClick={() =>
                document.getElementById("mapping-import")?.click()
              }
            >
              CSVインポート（上書き）
            </Button>
            <input
              id="mapping-import"
              ref={importInputRef}
              type="file"
              accept=".csv"
              onChange={handleImport}
              className="hidden"
            />
          </label>
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger render={<Button />}>手動追加</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>サービスマッピングを追加</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>サービスコード</Label>
                  <Input
                    value={form.service_code}
                    onChange={(e) =>
                      setForm({ ...form, service_code: e.target.value })
                    }
                    placeholder="例: 111211"
                  />
                </div>
                <div>
                  <Label>サービス名</Label>
                  <Input
                    value={form.service_name}
                    onChange={(e) =>
                      setForm({ ...form, service_name: e.target.value })
                    }
                    placeholder="例: 身体介護"
                  />
                </div>
                <div>
                  <Label>類型</Label>
                  <Select
                    value={form.category_id}
                    onValueChange={(v) =>
                      setForm({ ...form, category_id: v ?? "" })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="類型を選択">
                        {(v: string) => {
                          const c = categories.find((x) => x.id === v);
                          return c ? c.name : "類型を選択";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleAdd} className="w-full">
                  追加
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>サービスコード</TableHead>
            <TableHead>サービス名</TableHead>
            <TableHead>類型</TableHead>
            <TableHead className="w-[80px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mappings.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="text-center text-muted-foreground"
              >
                マッピングがありません
              </TableCell>
            </TableRow>
          ) : (
            mappings.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-mono">{m.service_code}</TableCell>
                <TableCell>{m.service_name}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {m.service_categories?.name}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(m.id)}
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ====================
// 時給設定タブ
// ====================
// 事業所 (行) × 類型 (列) の表で、選んだ月に有効な時給を出す。
// 時給は履歴で持つ (2026-09-22 user「類型と時給の結びつき (事業所ごと) と 月次の変更の履歴」):
//   セルを変えると「表示している月の 1 日から」の新しい行を作る (その月の行が既にあれば上書き)。前の月は元の時給のまま。
//   2000-01-01 の行 = 履歴を持つ前からの値。
const BASE_FROM = "2000-01-01";
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

function RatesTab({
  initialRates,
  initialCategories,
  initialOffices,
}: {
  initialRates: CategoryHourlyRate[];
  initialCategories: ServiceCategory[];
  initialOffices: Office[];
}) {
  const router = useRouter();
  const rates = initialRates;
  const categories = initialCategories.slice().sort((a, b) => a.sort_order - b.sort_order);
  const [month, setMonth] = useState(thisMonth());
  const [saving, setSaving] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const monthStart = `${month}-01`;
  const fetchData = useCallback(() => router.refresh(), [router]);

  const officesWithRates = new Set(rates.map((r) => r.office_id));
  const offices = initialOffices
    .filter((o) => o.office_type === "訪問介護" || officesWithRates.has(o.id))
    .slice().sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name, "ja"));
  const officeName = (o: Office) => o.short_name || o.name;

  // その月に有効な行 (適用開始 ≦ 月初 の最新) と、その月より後に予定されている変更
  const activeOf = new Map<string, CategoryHourlyRate>();
  const laterOf = new Map<string, CategoryHourlyRate[]>();
  for (const r of rates) {
    const k = `${r.office_id}|${r.category_id}`;
    const from = r.effective_from ?? BASE_FROM;
    if (from <= monthStart) {
      const cur = activeOf.get(k);
      if (!cur || (cur.effective_from ?? BASE_FROM) <= from) activeOf.set(k, r);
    } else {
      laterOf.set(k, [...(laterOf.get(k) ?? []), r]);
    }
  }
  const history = rates
    .filter((r) => (r.effective_from ?? BASE_FROM) > BASE_FROM)
    .slice().sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""));
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? "?";
  const offName = (id: string) => { const o = initialOffices.find((x) => x.id === id); return o ? officeName(o) : "?"; };

  // セルの時給を変える = この月の 1 日からの行を作る / 上書きする
  const saveCell = async (officeId: string, categoryId: string, raw: string) => {
    const k = `${officeId}|${categoryId}`;
    const cur = activeOf.get(k);
    const rate = raw.trim() === "" ? null : parseInt(raw, 10);
    if (rate === null) return; // 空にしただけでは消さない (消すのは 下の履歴から)
    if (isNaN(rate) || rate <= 0) { toast.error("時給は 1 以上の数字で入れてください"); return; }
    if (cur && cur.hourly_rate === rate) return;
    setSaving(true);
    const { error } = await supabase.from("payroll_category_hourly_rates").upsert(
      { office_id: officeId, category_id: categoryId, hourly_rate: rate, effective_from: monthStart, updated_at: new Date().toISOString() },
      { onConflict: "office_id,category_id,effective_from" });
    setSaving(false);
    if (error) { toast.error(`保存に失敗: ${error.message}`); return; }
    toast.success(`${offName(officeId)} ${catName(categoryId)}: ${month.replace("-", "年")}月から ${rate.toLocaleString()}円 にしました`);
    fetchData();
  };

  const handleDelete = async (r: CategoryHourlyRate) => {
    const from = r.effective_from ?? BASE_FROM;
    const label = from === BASE_FROM ? "最初からの時給" : `${from.slice(0, 7).replace("-", "年")}月からの時給`;
    if (!confirm(`${offName(r.office_id)} ${catName(r.category_id)} の ${label} (${r.hourly_rate.toLocaleString()}円) を消しますか？\n消すと その月からは 1 つ前の時給に戻ります。`)) return;
    const { error } = await supabase.from("payroll_category_hourly_rates").delete().eq("id", r.id);
    if (error) { toast.error(`削除に失敗: ${error.message}`); return; }
    toast.success("消しました");
    fetchData();
  };

  // 表示している月の時給を 事業所 × 類型 で出す
  const handleExport = () => {
    const rows: string[][] = [["事業所番号", "事業所名", "類型", "時給"]];
    for (const o of offices) for (const c of categories) {
      const r = activeOf.get(`${o.id}|${c.id}`);
      rows.push([o.office_number, officeName(o), c.name, r ? String(r.hourly_rate) : ""]);
    }
    downloadCsv(`時給設定_${month}.csv`, rows);
    toast.success(`${month.replace("-", "年")}月の時給を ${rows.length - 1} 件出力しました`);
  };

  // 取り込んだ時給は 表示している月の 1 日からの時給として入れる (違う値のものだけ)
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const clear = () => { if (importRef.current) importRef.current.value = ""; };
      const buf = ev.target?.result as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      const isUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      const enc = isUtf8Bom ? "utf-8" : (new TextDecoder("utf-8").decode(buf).includes("事業所番号") ? "utf-8" : "shift_jis");
      const parsed = parseCsvText(new TextDecoder(enc).decode(buf));
      if (parsed.length < 2) { toast.error("データ行がありません"); clear(); return; }
      const headers = parsed[0].map((h) => h.trim());
      const [oi, ci, ri] = ["事業所番号", "類型", "時給"].map((n) => headers.indexOf(n));
      if (oi < 0 || ci < 0 || ri < 0) { toast.error("ヘッダーに「事業所番号」「類型」「時給」が必要です"); clear(); return; }
      const officeByNumber = new Map(initialOffices.map((o) => [o.office_number, o]));
      const categoryByName = new Map(categories.map((c) => [c.name, c]));
      const upsertMap = new Map<string, { office_id: string; category_id: string; hourly_rate: number; effective_from: string }>();
      const errors: string[] = [];
      for (let i = 1; i < parsed.length; i++) {
        const r = parsed[i];
        const num = (r[oi] ?? "").trim(), cn = (r[ci] ?? "").trim(), rs = (r[ri] ?? "").trim();
        if (!num || !cn || !rs) continue;
        const o = officeByNumber.get(num);
        if (!o) { errors.push(`行${i + 1}: 事業所番号「${num}」が未登録`); continue; }
        const c = categoryByName.get(cn);
        if (!c) { errors.push(`行${i + 1}: 類型「${cn}」が未登録`); continue; }
        const rate = parseInt(rs, 10);
        if (isNaN(rate)) { errors.push(`行${i + 1}: 時給「${rs}」が数値ではありません`); continue; }
        if (rate <= 0 || activeOf.get(`${o.id}|${c.id}`)?.hourly_rate === rate) continue; // 変わらないものは入れない
        upsertMap.set(`${o.id}|${c.id}`, { office_id: o.id, category_id: c.id, hourly_rate: rate, effective_from: monthStart });
      }
      if (errors.length > 0) { toast.error(errors.slice(0, 5).join("\n")); clear(); return; }
      const rows = [...upsertMap.values()];
      if (rows.length === 0) { toast.message("今の時給と違うものはありませんでした"); clear(); return; }
      if (!confirm(`${rows.length} 件を ${month.replace("-", "年")}月からの時給として入れますか？ (前の月は元の時給のまま)`)) { clear(); return; }
      const { error } = await supabase.from("payroll_category_hourly_rates").upsert(rows, { onConflict: "office_id,category_id,effective_from" });
      if (error) { toast.error(`取り込みに失敗: ${error.message}`); clear(); return; }
      toast.success(`${rows.length} 件を取り込みました`);
      fetchData();
      clear();
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">表示する月
          <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 h-9 w-40" />
        </label>
        <p className="text-sm text-muted-foreground flex-1 min-w-[260px]">
          表の値は <b>{month.replace("-", "年")}月</b> に使われる時給です。セルを書き換えると <b>{month.replace("-", "年")}月から</b> の時給になり、それより前の月は元の時給のままです。
          <span className="text-amber-700"> 色付きのセル</span> = この月から変わった時給。
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport}>📥 CSV出力</Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>📤 CSV取り込み</Button>
          <input ref={importRef} type="file" accept=".csv" onChange={handleImport} className="hidden" />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="text-sm border-collapse">
          <thead className="bg-muted/60">
            <tr>
              <th className="sticky left-0 bg-muted px-3 py-2 text-left font-medium min-w-44">事業所</th>
              {categories.map((c) => <th key={c.id} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-24">{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {offices.map((o) => (
              <tr key={o.id} className="border-t hover:bg-muted/30">
                <td className="sticky left-0 bg-background px-3 py-1 whitespace-nowrap">{officeName(o)}</td>
                {categories.map((c) => {
                  const k = `${o.id}|${c.id}`;
                  const r = activeOf.get(k);
                  const changedHere = r && (r.effective_from ?? BASE_FROM) === monthStart;
                  const later = laterOf.get(k) ?? [];
                  const tip = [r ? `${(r.effective_from ?? BASE_FROM) === BASE_FROM ? "最初から" : `${r.effective_from!.slice(0, 7)} から`} ${r.hourly_rate}円` : "未設定",
                    ...later.map((x) => `${x.effective_from!.slice(0, 7)} から ${x.hourly_rate}円 (予定)`)].join("\n");
                  return (
                    <td key={`${k}|${month}|${r?.id ?? ""}|${r?.hourly_rate ?? ""}`} className="px-1 py-1" title={tip}>
                      <Input
                        type="number" min={1} step={1} disabled={saving}
                        defaultValue={r?.hourly_rate ?? ""} placeholder="—"
                        onBlur={(e) => saveCell(o.id, c.id, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        className={`h-8 w-24 text-right ${changedHere ? "bg-amber-50 border-amber-300" : ""} ${later.length ? "underline decoration-dotted" : ""}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h4 className="text-sm font-medium mb-2">時給の変更履歴 ({history.length} 件)</h4>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ変更はありません (全部 最初からの時給です)。</p>
        ) : (
          <table className="text-sm">
            <thead className="text-muted-foreground">
              <tr><th className="text-left pr-6 py-1 font-normal">適用開始</th><th className="text-left pr-6 font-normal">事業所</th><th className="text-left pr-6 font-normal">類型</th><th className="text-right pr-6 font-normal">時給</th><th /></tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="pr-6 py-1">{r.effective_from!.slice(0, 7).replace("-", "年")}月から</td>
                  <td className="pr-6">{offName(r.office_id)}</td>
                  <td className="pr-6">{catName(r.category_id)}</td>
                  <td className="pr-6 text-right">{r.hourly_rate.toLocaleString()}円</td>
                  <td><Button variant="ghost" size="sm" onClick={() => handleDelete(r)}>消す</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ====================
// メインページ
// ====================
export function ServicesContent({
  categories,
  mappings,
  rates,
  offices,
}: {
  categories: ServiceCategory[];
  mappings: ServiceTypeMapping[];
  rates: CategoryHourlyRate[];
  offices: Office[];
}) {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">サービスマスタ</h2>
      <Tabs defaultValue="categories">
        <TabsList>
          <TabsTrigger value="categories">類型</TabsTrigger>
          <TabsTrigger value="mappings">マッピング</TabsTrigger>
          <TabsTrigger value="rates">時給設定</TabsTrigger>
        </TabsList>
        <TabsContent value="categories" className="mt-4">
          <CategoriesTab initialCategories={categories} />
        </TabsContent>
        <TabsContent value="mappings" className="mt-4">
          <MappingsTab
            initialMappings={mappings}
            initialCategories={categories}
          />
        </TabsContent>
        <TabsContent value="rates" className="mt-4">
          <RatesTab
            initialRates={rates}
            initialCategories={categories}
            initialOffices={offices}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
