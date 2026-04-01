"use client";

import { useState, useEffect, useCallback } from "react";
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

interface ServiceCategory {
  id: string;
  name: string;
  sort_order: number;
}

interface ServiceTypeMapping {
  id: string;
  service_name: string;
  category_id: string;
  service_categories?: { name: string };
}

interface CategoryHourlyRate {
  id: string;
  office_id: string;
  category_id: string;
  hourly_rate: number;
  offices?: { name: string };
  service_categories?: { name: string };
}

interface Office {
  id: string;
  name: string;
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
      .from("service_categories")
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
      .from("service_categories")
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
      .from("service_categories")
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
  const [unmappedNames, setUnmappedNames] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({ service_name: "", category_id: "" });

  const fetchData = useCallback(async () => {
    const [mapRes, catRes, svcRes] = await Promise.all([
      supabase
        .from("service_type_mappings")
        .select("*, service_categories(name)")
        .order("service_name"),
      supabase.from("service_categories").select("*").order("sort_order"),
      supabase
        .from("service_records")
        .select("service_category")
        .limit(10000),
    ]);
    if (mapRes.data) setMappings(mapRes.data);
    if (catRes.data) setCategories(catRes.data);

    // CSV内のサービス型でまだマッピングされていないものを検出
    if (svcRes.data && mapRes.data) {
      const mappedNames = new Set(
        mapRes.data.map((m: ServiceTypeMapping) => m.service_name)
      );
      const allNames = [
        ...new Set(
          svcRes.data.map(
            (r: { service_category: string }) => r.service_category
          )
        ),
      ].filter((n): n is string => typeof n === "string" && n.trim() !== "");
      setUnmappedNames(
        allNames.filter((n) => !mappedNames.has(n)).sort()
      );
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAdd = async () => {
    if (!form.service_name || !form.category_id) {
      toast.error("サービス名と類型を選択してください");
      return;
    }
    const { error } = await supabase
      .from("service_type_mappings")
      .insert(form);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("マッピングを追加しました");
    setForm({ service_name: "", category_id: "" });
    setIsOpen(false);
    fetchData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このマッピングを削除しますか？")) return;
    const { error } = await supabase
      .from("service_type_mappings")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    fetchData();
  };

  const handleQuickMap = async (serviceName: string, categoryId: string) => {
    const { error } = await supabase
      .from("service_type_mappings")
      .insert({ service_name: serviceName, category_id: categoryId });
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success(`「${serviceName}」をマッピングしました`);
    fetchData();
  };

  return (
    <div className="space-y-4">
      {/* 未マッピング警告 */}
      {unmappedNames.length > 0 && (
        <div className="border border-orange-200 bg-orange-50 rounded-md p-4 space-y-3">
          <p className="text-sm font-medium">
            未マッピングのサービス型が {unmappedNames.length} 件あります
          </p>
          {unmappedNames.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <Badge variant="secondary">{name}</Badge>
              <Select
                onValueChange={(v) => {
                  if (v && typeof v === "string") handleQuickMap(name, v);
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="類型を選択" />
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
          CSVの「サービス型」と類型の紐付けを管理します
        </p>
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger render={<Button />}>マッピング追加</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>サービスマッピングを追加</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>サービス型名（CSVの値）</Label>
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
                    <SelectValue placeholder="類型を選択" />
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>CSVサービス型名</TableHead>
            <TableHead>類型</TableHead>
            <TableHead className="w-[80px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mappings.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={3}
                className="text-center text-muted-foreground"
              >
                マッピングがありません
              </TableCell>
            </TableRow>
          ) : (
            mappings.map((m) => (
              <TableRow key={m.id}>
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
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState({
    office_id: "",
    category_id: "",
    hourly_rate: "",
  });

  const fetchData = useCallback(async () => {
    const [rateRes, catRes, offRes] = await Promise.all([
      supabase
        .from("category_hourly_rates")
        .select("*, offices(name), service_categories(name)")
        .order("created_at"),
      supabase.from("service_categories").select("*").order("sort_order"),
      supabase.from("offices").select("id, name").order("name"),
    ]);
    if (rateRes.data) setRates(rateRes.data);
    if (catRes.data) setCategories(catRes.data);
    if (offRes.data) setOffices(offRes.data);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAdd = async () => {
    if (!form.office_id || !form.category_id || !form.hourly_rate) {
      toast.error("全項目を入力してください");
      return;
    }
    const { error } = await supabase.from("category_hourly_rates").insert({
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
      .from("category_hourly_rates")
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
      .from("category_hourly_rates")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error(`エラー: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    fetchData();
  };

  // 事業所ごとにグループ化
  const ratesByOffice = rates.reduce(
    (acc, r) => {
      const officeName = r.offices?.name ?? "不明";
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
              <div>
                <Label>類型</Label>
                <Select
                  value={form.category_id}
                  onValueChange={(v) =>
                    setForm({ ...form, category_id: v ?? "" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="類型を選択" />
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
