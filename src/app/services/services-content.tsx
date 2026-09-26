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
// 事業所ごとに「時給が同じ時期」を 1 行にまとめて出す (2026-09-22 user「変更履歴みたいな表示にして、変更がない時期はひとまとまりに」)。
//   例)  〜2026年3月 | 身体 2,000 | 生活 1,700 …
//        2026年4月〜 | 身体 2,100 | 生活 1,800 …
// 時給は履歴で持つ (payroll_category_hourly_rates.effective_from)。時期の区切り = その事業所の行の 適用開始日。
// 2000-01-01 = 履歴を持つ前からの値 (= 最初から)。
// 新しい時期を足すと 直前の時期の時給を全部コピーした行を作るので、各時期は全類型の行を持つ (前の時期を直しても後ろの時期に波及しない)。
const BASE_FROM = "2000-01-01";
const ymLabel = (d: string) => `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月`;
const prevMonthLabel = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); return m === 1 ? `${y - 1}年12月` : `${y}年${m - 1}月`; };
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
  const [officeFilter, setOfficeFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [addFor, setAddFor] = useState<string | null>(null);   // 新しい時期を足している事業所
  const [addMonth, setAddMonth] = useState(thisMonth());
  const [importMonth, setImportMonth] = useState(thisMonth());
  const importRef = useRef<HTMLInputElement>(null);
  /**
   * いま書き換えているセル ("事業所id|類型id|時期の開始日")。
   * ★ 既定は **ただの数字**として出す。以前は 全セルが入力枠で、値の無いところまで枠が出ていたため
   *   23 事業所 × 13 類型 = 約 300 個の枠が並び、桁も揃わず読めなかった (2026-09-26 user「めっちゃ見づらい」)。
   */
  const [editing, setEditing] = useState<string | null>(null);
  /** Esc で取り消したとき、続けて飛んでくる blur で保存しないための目印 */
  const cancelRef = useRef(false);
  /** どの事業所も値を持っていない類型を隠す。13 類型のうち実際に使うのは数個なので既定で隠す */
  const [hideEmpty, setHideEmpty] = useState(true);
  const fetchData = useCallback(() => router.refresh(), [router]);

  const officesWithRates = new Set(rates.map((r) => r.office_id));
  const offices = initialOffices
    .filter((o) => o.office_type === "訪問介護" || officesWithRates.has(o.id))
    .slice().sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name, "ja"));
  const officeName = (o: Office) => o.short_name || o.name;
  const shown = officeFilter ? offices.filter((o) => o.id === officeFilter) : offices;

  // 事業所ごとの 時期 (区切り = 行の適用開始日) と、各時期の 類型 → 行 (その時期の頭で有効な行)
  const periodsOf = (officeId: string) => {
    const rows = rates.filter((r) => r.office_id === officeId);
    const starts = [...new Set(rows.map((r) => r.effective_from ?? BASE_FROM))].sort();
    return starts.map((start, i) => {
      const byCat = new Map<string, CategoryHourlyRate>();
      for (const r of rows) {
        const f = r.effective_from ?? BASE_FROM;
        if (f > start) continue;
        const cur = byCat.get(r.category_id);
        if (!cur || (cur.effective_from ?? BASE_FROM) <= f) byCat.set(r.category_id, r);
      }
      const next = starts[i + 1];
      const label = start === BASE_FROM
        ? (next ? `〜${prevMonthLabel(next)}` : "ずっと")
        : (next ? `${ymLabel(start)}〜${prevMonthLabel(next)}` : `${ymLabel(start)}〜`);
      return { start, label, byCat, isLast: !next };
    });
  };
  const nowStart = `${thisMonth()}-01`;

  // 表に出す事業所ぶんだけ 先に時期を組み立てる (セルの描画で何度も呼ばないため)
  type Period = ReturnType<typeof periodsOf>[number];
  const periodsByOffice = new Map<string, Period[]>(shown.map((o) => [o.id, periodsOf(o.id)]));
  // どこにも値が無い類型は既定で隠す (横に切れて「列がもっとある」ことに気づけないため)
  const hasAnyValue = (categoryId: string) =>
    shown.some((o) => (periodsByOffice.get(o.id) ?? []).some((p) => p.byCat.has(categoryId)));
  const shownCategories = hideEmpty ? categories.filter((c) => hasAnyValue(c.id)) : categories;
  const hiddenCount = categories.length - shownCategories.length;

  // その時期の時給を直す = その時期の頭 (start) の行を作る / 上書きする
  const saveCell = async (officeId: string, categoryId: string, start: string, current: number | undefined, raw: string) => {
    if (raw.trim() === "") return; // 空にしただけでは消さない
    const rate = parseInt(raw, 10);
    if (isNaN(rate) || rate <= 0) { toast.error("時給は 1 以上の数字で入れてください"); return; }
    if (current === rate) return;
    setSaving(true);
    const { error } = await supabase.from("payroll_category_hourly_rates").upsert(
      { office_id: officeId, category_id: categoryId, hourly_rate: rate, effective_from: start, updated_at: new Date().toISOString() },
      { onConflict: "office_id,category_id,effective_from" });
    setSaving(false);
    if (error) { toast.error(`保存に失敗: ${error.message}`); return; }
    toast.success("保存しました。給与計算をやり直すと反映されます");
    fetchData();
  };

  // 新しい時期を足す: 直前の時期の時給を全部コピーした行を 指定月の 1 日で作る。あとは セルで直す
  const addPeriod = async (officeId: string) => {
    const start = `${addMonth}-01`;
    const periods = periodsOf(officeId);
    if (periods.some((p) => p.start === start)) { toast.error(`${ymLabel(start)}から の時期は もうあります`); return; }
    const before = periods.filter((p) => p.start < start).at(-1);
    const rows = before ? [...before.byCat.values()].map((r) => ({ office_id: officeId, category_id: r.category_id, hourly_rate: r.hourly_rate, effective_from: start })) : [];
    if (rows.length === 0) { toast.error("コピー元の時給がありません。先に時給を入れてください"); return; }
    setSaving(true);
    const { error } = await supabase.from("payroll_category_hourly_rates").insert(rows);
    setSaving(false);
    if (error) { toast.error(`追加に失敗: ${error.message}`); return; }
    toast.success(`${ymLabel(start)}からの時期を足しました。変わる類型の時給を書き換えてください`);
    setAddFor(null);
    fetchData();
  };

  // 時期を消す: その時期の頭の行を全部消す (前の時期がそのまま続く)。最初の時期は消さない
  const deletePeriod = async (officeId: string, start: string, label: string) => {
    if (!confirm(`${offName(officeId)} の「${label}」の時期を消しますか？\n消すと 1 つ前の時期の時給がそのまま続きます。`)) return;
    setSaving(true);
    const { error } = await supabase.from("payroll_category_hourly_rates").delete().eq("office_id", officeId).eq("effective_from", start);
    setSaving(false);
    if (error) { toast.error(`削除に失敗: ${error.message}`); return; }
    toast.success("消しました");
    fetchData();
  };
  const offName = (id: string) => { const o = initialOffices.find((x) => x.id === id); return o ? officeName(o) : "?"; };

  // 今月に使われる時給を 事業所 × 類型 で出す
  const handleExport = () => {
    const rows: string[][] = [["事業所番号", "事業所名", "類型", "時給"]];
    for (const o of offices) {
      const p = periodsOf(o.id).filter((x) => x.start <= nowStart).at(-1);
      for (const c of categories) {
        const r = p?.byCat.get(c.id);
        rows.push([o.office_number, officeName(o), c.name, r ? String(r.hourly_rate) : ""]);
      }
    }
    downloadCsv(`時給設定_${thisMonth()}.csv`, rows);
    toast.success(`今月の時給を ${rows.length - 1} 件出力しました`);
  };

  // 取り込んだ時給は 「取り込みの適用開始月」からの時給として入れる (今と違う値のものだけ)
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const start = `${importMonth}-01`;
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
        const cur = periodsOf(o.id).filter((x) => x.start <= start).at(-1)?.byCat.get(c.id)?.hourly_rate;
        if (rate <= 0 || cur === rate) continue;
        upsertMap.set(`${o.id}|${c.id}`, { office_id: o.id, category_id: c.id, hourly_rate: rate, effective_from: start });
      }
      if (errors.length > 0) { toast.error(errors.slice(0, 5).join("\n")); clear(); return; }
      const rows = [...upsertMap.values()];
      if (rows.length === 0) { toast.message("今の時給と違うものはありませんでした"); clear(); return; }
      if (!confirm(`${rows.length} 件を ${ymLabel(start)}からの時給として入れますか？ (それより前は元の時給のまま)`)) { clear(); return; }
      const { error } = await supabase.from("payroll_category_hourly_rates").upsert(rows, { onConflict: "office_id,category_id,effective_from" });
      if (error) { toast.error(`取り込みに失敗: ${error.message}`); clear(); return; }
      toast.success(`${rows.length} 件を取り込みました`);
      fetchData();
      clear();
    };
    reader.readAsArrayBuffer(file);
  };

  /**
   * 時給 1 つぶんのセル。★ 普段は数字だけ、押すと入力欄になる。
   * 保存の道筋 (saveCell) は入力欄だったときと同じ。
   */
  // ⚠ コンポーネントにせず **ただの関数**にする。レンダー関数の中で定義したコンポーネントは
  //   再レンダーのたびに型が変わり、React が毎回 unmount/remount するため 入力中にフォーカスが飛ぶ
  const rateCell = (office: Office, categoryId: string, period: Period, prev: Period | undefined) => {
    const r = period.byCat.get(categoryId);
    const key = `${office.id}|${categoryId}|${period.start}`;
    const before = prev?.byCat.get(categoryId)?.hourly_rate;
    const changed = !!prev && !!r && before !== r.hourly_rate;
    if (editing === key) {
      return (
        <Input
          type="number" min={1} step={1} disabled={saving} autoFocus
          defaultValue={r?.hourly_rate ?? ""} placeholder="—"
          onBlur={(e) => {
            const v = e.target.value;
            setEditing(null);
            if (cancelRef.current) { cancelRef.current = false; return; }
            void saveCell(office.id, categoryId, period.start, r?.hourly_rate, v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") { cancelRef.current = true; (e.target as HTMLInputElement).blur(); }
          }}
          className="h-7 w-24 text-right tabular-nums"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => setEditing(key)}
        title={changed ? `前の時期 ${before?.toLocaleString() ?? "未設定"}円 から変更。押すと書き換えられます` : "押すと書き換えられます"}
        className={`h-7 w-24 rounded px-2 text-right tabular-nums transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          r ? (changed ? "font-semibold text-amber-700" : "") : "text-muted-foreground/40"
        }`}
      >
        {r ? r.hourly_rate.toLocaleString() : "—"}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {/* 操作の帯。説明は表のすぐ上に 1 行だけ置く (以前は絞り込みの真横で場所を取っていた) */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm">事業所
          <select className="block mt-1 h-9 rounded-md border bg-background px-2 text-sm" value={officeFilter} onChange={(e) => setOfficeFilter(e.target.value)}>
            <option value="">すべて ({offices.length})</option>
            {offices.map((o) => <option key={o.id} value={o.id}>{officeName(o)}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <Button variant="outline" onClick={handleExport}>📥 CSV出力 (今月)</Button>
          <label className="text-xs text-muted-foreground">取り込みの適用開始月
            <Input type="month" value={importMonth} onChange={(e) => e.target.value && setImportMonth(e.target.value)} className="mt-0.5 h-9 w-36" />
          </label>
          <Button variant="outline" onClick={() => importRef.current?.click()}>📤 CSV取り込み</Button>
          <input ref={importRef} type="file" accept=".csv" onChange={handleImport} className="hidden" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>時給が同じ時期を 1 行にまとめています。<b className="font-medium text-foreground">数字を押すと書き換えられます</b> (Enter で確定 / Esc で取り消し)。</span>
        {hiddenCount > 0 || !hideEmpty ? (
          <label className="inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="h-3.5 w-3.5" />
            どこにも時給が入っていない類型を隠す
            {hideEmpty && hiddenCount > 0 && <span className="rounded bg-muted px-1.5 py-0.5">{hiddenCount} 列を非表示</span>}
          </label>
        ) : null}
      </div>

      {/*
        ⚠ 高さを決めた overflow-auto の中でないと sticky は効かない。
          以前は overflow-x-auto だけで高さも無く、**見出しは実際には固定されていなかった**。
        ⚠ border-collapse だと sticky セルの罫線が描画されない。border-separate + border-spacing-0 にする。
      */}
      <div className="max-h-[calc(100vh-17rem)] overflow-auto rounded-lg border">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 border-b border-r bg-muted px-3 py-2 text-left font-medium min-w-[12rem]">事業所</th>
              <th className="sticky top-0 z-20 border-b bg-muted px-3 py-2 text-left font-medium whitespace-nowrap">時期</th>
              {shownCategories.map((c) => (
                <th key={c.id} className="sticky top-0 z-20 border-b bg-muted px-2 py-2 text-right font-medium whitespace-nowrap">
                  {c.name}<span className="ml-1 font-normal text-[10px] text-muted-foreground">円</span>
                </th>
              ))}
              <th className="sticky top-0 z-20 border-b bg-muted" />
            </tr>
          </thead>
          <tbody>
            {shown.map((o, oi) => {
              const periods = periodsByOffice.get(o.id) ?? [];
              // 事業所ごとに 薄い縞を付けて「ここからここまでが 1 事業所」と分かるようにする。
              // ⚠ 左の固定列は 不透明でないと横スクロールで下の文字が透けるので 縞を付けない
              const zebra = oi % 2 === 1 ? "bg-muted/30" : "";
              const rowCount = Math.max(1, periods.length);
              const nameCell = (
                <td rowSpan={rowCount} className="sticky left-0 z-10 border-t border-r bg-background px-3 py-1.5 align-top">
                  <div className="font-medium leading-tight">{officeName(o)}</div>
                  {addFor === o.id ? (
                    <div className="mt-1.5 space-y-1">
                      <Input type="month" value={addMonth} onChange={(e) => e.target.value && setAddMonth(e.target.value)} className="h-7 w-32" />
                      <div className="flex gap-1">
                        <Button size="sm" className="h-6 px-2 text-xs" disabled={saving} onClick={() => addPeriod(o.id)}>追加</Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setAddFor(null)}>やめる</Button>
                      </div>
                    </div>
                  ) : periods.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => { setAddFor(o.id); setAddMonth(thisMonth()); }}
                      className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      ＋ 時給が変わる月
                    </button>
                  ) : null}
                </td>
              );

              if (periods.length === 0) {
                return (
                  <tr key={o.id} className={`${zebra} hover:bg-primary/5`}>
                    {nameCell}
                    <td className="border-t px-3 py-1 text-muted-foreground whitespace-nowrap">時給が未設定</td>
                    {shownCategories.map((c) => (
                      <td key={c.id} className="border-t px-1 py-1 text-right">
                        <Input type="number" min={1} disabled={saving} placeholder="—" className="h-7 w-24 text-right tabular-nums"
                          onBlur={(e) => saveCell(o.id, c.id, BASE_FROM, undefined, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                      </td>
                    ))}
                    <td className="border-t" />
                  </tr>
                );
              }

              return periods.map((p, i) => {
                const current = p.start <= nowStart && (p.isLast || periods[i + 1].start > nowStart);
                const prev = periods[i - 1];
                // 事業所の切れ目だけ太い線。同じ事業所の中の時期は細い線で続ける
                const top = i === 0 ? "border-t-2" : "border-t";
                return (
                  <tr key={`${o.id}-${p.start}`} className={`${zebra} hover:bg-primary/5 ${current ? "" : "text-muted-foreground"}`}>
                    {i === 0 && nameCell}
                    <td className={`${top} px-3 py-1 whitespace-nowrap`}>
                      {p.label}
                      {current && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">今</span>}
                    </td>
                    {shownCategories.map((c) => (
                      <td key={c.id} className={`${top} px-1 py-0.5 text-right`}>
                        {rateCell(o, c.id, p, prev)}
                      </td>
                    ))}
                    <td className={`${top} px-2 text-right`}>
                      {p.start !== BASE_FROM && (
                        <button
                          type="button" disabled={saving}
                          onClick={() => deletePeriod(o.id, p.start, p.label)}
                          aria-label={`${officeName(o)} の ${p.label} の時期を消す`}
                          title={`${p.label} の時期を消す`}
                          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-60 hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-amber-700">色付きの数字</span> = 前の時期から変わった時給。
        給与計算は その月が入る時期の時給を使います。
      </p>
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
