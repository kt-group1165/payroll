"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
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

interface ServiceCategory {
  id: string;
  name: string;
  sort_order: number;
}

interface ServiceTypeMapping {
  id: string;
  service_code: string;
  service_name: string;
  category_id: string;
  service_categories?: { name: string };
}

interface UnmappedService {
  service_code: string;
  service_name: string;
}

interface CategoryHourlyRate {
  id: string;
  office_id: string;
  category_id: string;
  hourly_rate: number;
  /** payroll_offices.short_name + master offices.name via nested JOIN */
  offices?: { short_name: string; master?: { name: string } | null };
  service_categories?: { name: string };
}

interface Office {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
}

// ====================
// 類型管理タブ
// ====================
function CategoriesTab() {
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const fetch = useCallback(async () => {
    const { data } = await supabase
      .from("payroll_service_categories")
      .select("*")
      .order("sort_order");
    if (data) setCategories(data);
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

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
function MappingsTab() {
  const [mappings, setMappings] = useState<ServiceTypeMapping[]>([]);
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedService[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({
    service_code: "",
    service_name: "",
    category_id: "",
  });
  const importInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.value = "";
  }, []);

  const fetchData = useCallback(async () => {
    const [mapRes, catRes] = await Promise.all([
      supabase
        .from("payroll_service_type_mappings")
        .select("*, service_categories(name)")
        .order("service_code"),
      supabase.from("payroll_service_categories").select("*").order("sort_order"),
    ]);
    if (mapRes.data) setMappings(mapRes.data);
    if (catRes.data) setCategories(catRes.data);

    // 未マッピングのサービスコードを検出（ページング取得で上限回避）
    if (mapRes.data) {
      const mappedCodes = new Set(
        mapRes.data.map((m: ServiceTypeMapping) => m.service_code)
      );
      const codeNameMap = new Map<string, string>();
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("payroll_service_records")
          .select("service_code,service_type")
          .order("id")
          .range(from, from + pageSize - 1);
        if (!data || data.length === 0) break;
        for (const r of data) {
          const code = (r as { service_code: string; service_type: string }).service_code;
          const name = (r as { service_code: string; service_type: string }).service_type;
          if (code && code.trim() && !codeNameMap.has(code)) {
            codeNameMap.set(code, name || "");
          }
        }
        if (data.length < pageSize) break;
        from += pageSize;
      }
      const unmappedList: UnmappedService[] = [];
      for (const [code, name] of codeNameMap) {
        if (!mappedCodes.has(code)) {
          unmappedList.push({ service_code: code, service_name: name });
        }
      }
      unmappedList.sort((a, b) => a.service_code.localeCompare(b.service_code));
      setUnmapped(unmappedList);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
    await supabase
      .from("payroll_service_type_mappings")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");

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
      {/* 未マッピング警告 */}
      {unmapped.length > 0 && (
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
function RatesTab() {
  const [rates, setRates] = useState<CategoryHourlyRate[]>([]);
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [mappings, setMappings] = useState<ServiceTypeMapping[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({
    office_id: "",
    category_id: "",
    hourly_rate: "",
  });
  const importRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(async () => {
    const [rateRes, catRes, offRes, mapRes] = await Promise.all([
      supabase
        .from("payroll_category_hourly_rates")
        .select("*, offices:payroll_offices!office_id(short_name, master:offices!office_id(name)), service_categories(name)")
        .order("created_at"),
      supabase.from("payroll_service_categories").select("*").order("sort_order"),
      supabase
        .from("payroll_offices")
        .select(`id, office_number, short_name, office_type, ${OFFICE_MASTER_JOIN}`),
      supabase
        .from("payroll_service_type_mappings")
        .select("*, service_categories(name)")
        .order("service_code"),
    ]);
    if (rateRes.data) setRates(rateRes.data);
    if (catRes.data) setCategories(catRes.data);
    if (offRes.data) {
      const flattened = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
      flattened.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setOffices(flattened);
    }
    if (mapRes.data) setMappings(mapRes.data);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAdd = async () => {
    if (!form.office_id || !form.category_id || !form.hourly_rate) {
      toast.error("全項目を入力してください");
      return;
    }
    const { error } = await supabase.from("payroll_category_hourly_rates").insert({
      office_id: form.office_id,
      category_id: form.category_id,
      hourly_rate: parseInt(form.hourly_rate, 10),
    });
    if (error) {
      if (error.message.includes("duplicate")) {
        toast.error("この事業所×類型の組み合わせは既に登録されています");
      } else {
        toast.error(`エラー: ${error.message}`);
      }
      return;
    }
    toast.success("時給を設定しました");
    setForm({ office_id: "", category_id: "", hourly_rate: "" });
    setIsOpen(false);
    fetchData();
  };

  const handleUpdateRate = async (id: string, newRate: string) => {
    const rate = parseInt(newRate, 10);
    if (isNaN(rate) || rate <= 0) return;
    const { error } = await supabase
      .from("payroll_category_hourly_rates")
      .update({ hourly_rate: rate })
      .eq("id", id);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("時給を更新しました");
    fetchData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この時給設定を削除しますか？")) return;
    const { error } = await supabase
      .from("payroll_category_hourly_rates")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    fetchData();
  };

  // 事業所 × 類型 単位でCSV出力（UIと同じ粒度・DB保存と同じ粒度）
  // 対象: 訪問介護事業所 + 既に時給が1件以上設定されている事業所
  const handleExport = () => {
    const rateByKey = new Map<string, number>();
    const officesWithRates = new Set<string>();
    for (const r of rates) {
      rateByKey.set(`${r.office_id}|${r.category_id}`, r.hourly_rate);
      officesWithRates.add(r.office_id);
    }
    const targetOffices = offices
      .filter((o) => o.office_type === "訪問介護" || officesWithRates.has(o.id))
      .slice()
      .sort((a, b) => a.office_number.localeCompare(b.office_number));
    const sortedCategories = categories.slice().sort((a, b) => a.sort_order - b.sort_order);

    const rows: string[][] = [
      ["事業所番号", "事業所名", "類型", "時給"],
    ];
    for (const office of targetOffices) {
      for (const c of sortedCategories) {
        const rate = rateByKey.get(`${office.id}|${c.id}`);
        rows.push([
          office.office_number,
          office.short_name || office.name,
          c.name,
          rate != null ? rate.toString() : "",
        ]);
      }
    }
    downloadCsv("時給設定.csv", rows);
    toast.success(`${targetOffices.length}事業所 × ${sortedCategories.length}類型 = ${rows.length - 1}件をエクスポートしました`);
  };

  // UTF-8/Shift-JIS両対応、事業所番号＋類型名をキーに(office_id, category_id)へ変換してupsert
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
            return tryUtf8.includes("事業所番号") ? "utf-8" : "shift_jis";
          })();
      const text = new TextDecoder(enc).decode(buf);
      const parsed = parseCsvText(text);
      if (parsed.length < 2) {
        toast.error("データ行がありません");
        if (importRef.current) importRef.current.value = "";
        return;
      }

      const headers = parsed[0].map((h) => h.trim());
      const idx = (name: string) => headers.indexOf(name);
      const officeNumIdx = idx("事業所番号");
      const categoryIdx = idx("類型");
      const rateIdx = idx("時給");
      if (officeNumIdx < 0 || categoryIdx < 0 || rateIdx < 0) {
        toast.error("ヘッダーに「事業所番号」「類型」「時給」が必要です");
        if (importRef.current) importRef.current.value = "";
        return;
      }

      const officeByNumber = new Map(offices.map((o) => [o.office_number, o]));
      const categoryByName = new Map(categories.map((c) => [c.name, c]));

      // (office_id, category_id)で重複排除（最後の値が勝つ）
      const upsertMap = new Map<
        string,
        { office_id: string; category_id: string; hourly_rate: number }
      >();
      const errors: string[] = [];

      for (let i = 1; i < parsed.length; i++) {
        const r = parsed[i];
        const officeNum = (r[officeNumIdx] ?? "").trim();
        const catName = (r[categoryIdx] ?? "").trim();
        const rateStr = (r[rateIdx] ?? "").trim();
        if (!officeNum || !catName) continue;
        if (!rateStr) continue; // 時給が空欄の行は未設定としてスキップ

        const office = officeByNumber.get(officeNum);
        if (!office) {
          errors.push(`行${i + 1}: 事業所番号「${officeNum}」が未登録`);
          continue;
        }
        const cat = categoryByName.get(catName);
        if (!cat) {
          errors.push(`行${i + 1}: 類型「${catName}」が未登録`);
          continue;
        }
        const rate = parseInt(rateStr, 10);
        if (isNaN(rate)) {
          errors.push(`行${i + 1}: 時給「${rateStr}」が数値ではありません`);
          continue;
        }
        if (rate <= 0) continue;

        upsertMap.set(`${office.id}|${cat.id}`, {
          office_id: office.id,
          category_id: cat.id,
          hourly_rate: rate,
        });
      }

      if (errors.length > 0) {
        toast.error(errors.slice(0, 5).join("\n"));
        if (importRef.current) importRef.current.value = "";
        return;
      }

      const upsertRows = Array.from(upsertMap.values());
      if (upsertRows.length === 0) {
        toast.error("取り込むデータがありません");
        if (importRef.current) importRef.current.value = "";
        return;
      }
      if (!confirm(`${upsertRows.length}件を取り込みますか？（既存設定は上書き）`)) {
        if (importRef.current) importRef.current.value = "";
        return;
      }

      const { error } = await supabase
        .from("payroll_category_hourly_rates")
        .upsert(upsertRows, { onConflict: "office_id,category_id" });
      if (error) {
        toast.error(`インポートエラー: ${error.message}`);
        if (importRef.current) importRef.current.value = "";
        return;
      }
      toast.success(`${upsertRows.length}件をインポートしました`);
      fetchData();
      if (importRef.current) importRef.current.value = "";
    };
    reader.readAsArrayBuffer(file);
  };

  // 事業所ごとにグループ化
  const ratesByOffice = rates.reduce(
    (acc, r) => {
      const officeName = (r.offices?.short_name || r.offices?.master?.name) ?? "不明";
      if (!acc[officeName]) acc[officeName] = [];
      acc[officeName].push(r);
      return acc;
    },
    {} as Record<string, CategoryHourlyRate[]>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          事業所 × 類型ごとの時給を設定します
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport}>📥 CSV出力</Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>
            📤 CSV取り込み
          </Button>
          <input
            ref={importRef}
            type="file"
            accept=".csv"
            onChange={handleImport}
            className="hidden"
          />
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger render={<Button />}>時給を追加</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>時給設定を追加</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>事業所</Label>
                <Select
                  value={form.office_id}
                  onValueChange={(v) =>
                    setForm({ ...form, office_id: v ?? "" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="事業所を選択">
                      {(v: string) => {
                        const o = offices.find((x) => x.id === v);
                        return o ? (o.short_name || o.name) : "事業所を選択";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    className="max-h-[60vh] min-w-[360px]"
                  >
                    {offices.filter((o) => o.office_type === "訪問介護").map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.short_name || o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <div>
                <Label>時給（円）</Label>
                <Input
                  type="number"
                  value={form.hourly_rate}
                  onChange={(e) =>
                    setForm({ ...form, hourly_rate: e.target.value })
                  }
                  placeholder="例: 1500"
                />
              </div>
              <Button onClick={handleAdd} className="w-full">
                追加
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {Object.keys(ratesByOffice).length === 0 ? (
        <p className="text-center text-muted-foreground py-8">
          時給が設定されていません
        </p>
      ) : (
        Object.entries(ratesByOffice).map(([officeName, officeRates]) => (
          <div key={officeName}>
            <h4 className="font-medium text-sm mb-2">{officeName}</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>類型</TableHead>
                  <TableHead className="w-[150px]">時給</TableHead>
                  <TableHead className="w-[80px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {officeRates.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Badge variant="secondary">
                        {r.service_categories?.name}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          defaultValue={r.hourly_rate}
                          className="w-[100px]"
                          onBlur={(e) =>
                            handleUpdateRate(r.id, e.target.value)
                          }
                        />
                        <span className="text-sm text-muted-foreground">
                          円
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(r.id)}
                      >
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}
    </div>
  );
}

// ====================
// メインページ
// ====================
export default function ServicesPage() {
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
          <CategoriesTab />
        </TabsContent>
        <TabsContent value="mappings" className="mt-4">
          <MappingsTab />
        </TabsContent>
        <TabsContent value="rates" className="mt-4">
          <RatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
