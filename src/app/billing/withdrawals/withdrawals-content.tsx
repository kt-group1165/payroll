"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { Company } from "@/types/database";

/**
 * 引落結果（不可データ）取り込み
 * /billing/withdrawals
 *
 * 流れ:
 *   1. 法人・引落月・引落実行日を選ぶ
 *   2. 銀行から来た「引落不可リスト」CSVをドロップ
 *   3. CSV の列マッピングで 利用者番号列 を指定
 *   4. プレビュー:
 *      - 対象月の invoiced 件数 / 不可件数 / 自動paid件数
 *   5. 実行: invoiced の各行について
 *       - CSVに番号あり → status=overdue
 *       - なし → status=paid, paid_amount=invoiced_amount, actual_withdrawal_date=引落日
 */

export type BillingRow = {
  id: string;
  segment: "介護" | "障害" | "自費";
  office_number: string;
  client_number: string;
  client_name: string | null;
  billing_month: string;
  invoiced_amount: number | null;
  amount: number;
  billing_status: string;
};

// ─── CSV 簡易パーサ (shift-jis / utf-8 自動判別) ──────
async function readCsvAuto(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // UTF-8 BOM 判定
  const isUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  let text: string;
  if (isUtf8Bom) {
    text = new TextDecoder("utf-8").decode(buf);
  } else {
    // UTF-8 として読んで明らかにデコードエラーがあれば shift-jis を試す
    try {
      const tryUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      text = tryUtf8;
    } catch {
      text = new TextDecoder("shift_jis").decode(buf);
    }
  }
  // CSV parse
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\r") { /* ignore */ }
      else if (c === "\n") { cur.push(field); field = ""; rows.push(cur); cur = []; }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function WithdrawalsContent({
  companies,
  selectedCompanyId,
  billingMonth,
  invoicedRows,
}: {
  companies: Company[];
  selectedCompanyId: string;
  billingMonth: string;
  invoicedRows: BillingRow[];
}) {
  const router = useRouter();
  const [withdrawalDate, setWithdrawalDate] = useState(() => new Date().toISOString().slice(0, 10));
  // CSV (client-only)
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [clientColIdx, setClientColIdx] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // filter 変更は URL params 更新で server 再評価
  const updateFilter = (companyId: string, month: string) => {
    const params = new URLSearchParams();
    if (companyId) params.set("company", companyId);
    if (month) params.set("month", month);
    const qs = params.toString();
    router.push(`/billing/withdrawals${qs ? `?${qs}` : ""}`);
  };

  const handleFile = async (f: File) => {
    try {
      const rows = await readCsvAuto(f);
      setCsvRows(rows);
      setFileName(f.name);
      setDone(false);
      // 列自動推定: ヘッダに「利用者番号」「顧客番号」「お客様番号」等を含む列を探す
      if (rows.length > 0) {
        const header = rows[0];
        const guess = header.findIndex((h) => /利用者番号|顧客番号|お客様番号|会員番号|口座番号/.test(h));
        if (guess >= 0) setClientColIdx(guess);
      }
    } catch (e) {
      toast.error(`CSV 読み込みエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // CSV から 利用者番号の集合を作る
  const csvClientNumbers = useMemo(() => {
    if (!csvRows || clientColIdx == null) return new Set<string>();
    const set = new Set<string>();
    for (let i = 1; i < csvRows.length; i++) {
      const n = (csvRows[i][clientColIdx] ?? "").trim();
      if (n) set.add(n);
    }
    return set;
  }, [csvRows, clientColIdx]);

  // プレビュー集計
  const preview = useMemo(() => {
    const total = invoicedRows.length;
    let unpaidCount = 0;
    let paidCount = 0;
    for (const r of invoicedRows) {
      if (csvClientNumbers.has(r.client_number)) unpaidCount++;
      else paidCount++;
    }
    return { total, unpaidCount, paidCount };
  }, [invoicedRows, csvClientNumbers]);

  const handleExecute = async () => {
    if (invoicedRows.length === 0) { toast.error("対象 invoiced 行がありません"); return; }
    if (clientColIdx == null) { toast.error("利用者番号列を選択してください"); return; }
    if (!confirm(
      `以下の更新を実行します:\n` +
      `  ・引落不可 → overdue: ${preview.unpaidCount} 件\n` +
      `  ・引落成功 → paid:    ${preview.paidCount} 件\n` +
      `  引落日: ${withdrawalDate}\n\nよろしいですか？`
    )) return;

    setBusy(true);
    try {
      const toOverdue: string[] = [];
      const toPaid: { id: string; amount: number }[] = [];
      for (const r of invoicedRows) {
        if (csvClientNumbers.has(r.client_number)) {
          if (r.billing_status !== "overdue") toOverdue.push(r.id);
        } else {
          if (r.billing_status !== "paid") toPaid.push({ id: r.id, amount: r.invoiced_amount ?? r.amount });
        }
      }
      // overdue 更新
      if (toOverdue.length > 0) {
        const chunk = 200;
        for (let i = 0; i < toOverdue.length; i += chunk) {
          const ids = toOverdue.slice(i, i + chunk);
          const { error } = await supabase
            .from("payroll_billing_amount_items")
            .update({
              billing_status: "overdue",
              lifecycle_note: `引落不可 (${withdrawalDate}) 取り込み`,
            })
            .in("id", ids);
          if (error) throw error;
        }
      }
      // paid 更新 (行ごとに paid_amount が異なるので個別)
      for (const t of toPaid) {
        const { error } = await supabase
          .from("payroll_billing_amount_items")
          .update({
            billing_status: "paid",
            actual_withdrawal_date: withdrawalDate,
            paid_amount: t.amount,
          })
          .eq("id", t.id);
        if (error) throw error;
      }
      toast.success(`完了: overdue ${toOverdue.length} 件 / paid ${toPaid.length} 件`);
      setDone(true);
      router.refresh();
    } catch (e) {
      toast.error(`更新エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const monthOptions = useMemo(() => {
    const now = new Date();
    const list: string[] = [];
    for (let i = -3; i <= 2; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      list.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return list.sort().reverse();
  }, []);

  const handleDownloadSample = () => {
    // 請求対象の利用者からサンプルを抽出 (先頭5件程度を不可扱いで生成)
    const sample: string[][] = [
      ["利用者番号", "利用者氏名", "請求額", "不可理由コード", "不可理由"],
    ];
    const picks = invoicedRows.slice(0, Math.min(5, invoicedRows.length));
    const reasons = [
      ["01", "残高不足"],
      ["02", "口座解約"],
      ["03", "依頼書なし"],
      ["04", "預金者による引落中止"],
      ["99", "その他"],
    ];
    picks.forEach((r, i) => {
      const [code, reason] = reasons[i % reasons.length];
      sample.push([
        r.client_number,
        r.client_name ?? "",
        String(r.invoiced_amount ?? r.amount),
        code,
        reason,
      ]);
    });
    if (picks.length === 0) {
      // 対象月のデータがなければダミーを入れる
      sample.push(["1234567890", "山田 太郎", "12340", "01", "残高不足"]);
      sample.push(["2345678901", "佐藤 花子", "8500", "02", "口座解約"]);
    }
    const csv = sample.map((r) => r.map((c) => {
      const needsQuote = c.includes(",") || c.includes('"') || c.includes("\n");
      const esc = c.replace(/"/g, '""');
      return needsQuote ? `"${esc}"` : esc;
    }).join(",")).join("\r\n");
    // BOM 付き UTF-8 で出力（Excel で開けるように）
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const monthTag = billingMonth || "sample";
    a.download = `引落不可_${monthTag}_サンプル.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-3">引落結果取り込み</h2>
      <p className="text-sm text-muted-foreground mb-4">
        銀行から来た「引落不可CSV」を取り込むと、対象月の請求のうち不可リストにある行は <b>overdue</b>、無い行は <b>paid</b> に自動遷移します。
      </p>

      {/* サンプルCSV */}
      <div className="border rounded-md p-3 mb-4 bg-muted/30">
        <p className="text-sm font-semibold mb-1">📋 CSV様式（サンプル）</p>
        <p className="text-xs text-muted-foreground mb-2">
          下記のような CSV を想定しています。列順は任意で、<b>利用者番号</b>の列さえあれば取り込み可能。文字コードは UTF-8 / Shift-JIS どちらでもOK。
        </p>
        <div className="bg-background border rounded p-2 text-[11px] font-mono overflow-x-auto whitespace-pre mb-2">
{`利用者番号,利用者氏名,請求額,不可理由コード,不可理由
1234567890,山田 太郎,12340,01,残高不足
2345678901,佐藤 花子,8500,02,口座解約
3456789012,鈴木 次郎,5000,01,残高不足`}
        </div>
        <Button variant="outline" size="sm" onClick={handleDownloadSample}>
          📥 サンプルCSVダウンロード
        </Button>
        <p className="text-[10px] text-muted-foreground mt-2">
          ※ ダウンロードされるサンプルは、上で選択した対象月・法人の invoiced 行を元に生成します（対象行が無ければダミーデータ）。<br />
          ※ 実運用では、銀行から届いた不可リストCSVをそのまま使ってください。不要な列があっても構いません（利用者番号列を選択するだけ）。
        </p>
      </div>

      {/* 対象選択 */}
      <div className="border rounded-md p-3 mb-4 space-y-2">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">法人</Label>
            <select className="w-full border rounded px-2 py-1 text-sm bg-background"
              value={selectedCompanyId} onChange={(e) => updateFilter(e.target.value, billingMonth)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs">対象請求月</Label>
            <select className="w-full border rounded px-2 py-1 text-sm bg-background"
              value={billingMonth} onChange={(e) => updateFilter(selectedCompanyId, e.target.value)}>
              <option value="">選択…</option>
              {monthOptions.map((m) => (
                <option key={m} value={m}>{m.slice(0, 4)}年{parseInt(m.slice(4, 6), 10)}月</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">引落実行日</Label>
            <Input type="date" value={withdrawalDate} onChange={(e) => setWithdrawalDate(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          対象月の invoiced/overdue 行: <b>{invoicedRows.length}</b> 件
        </p>
      </div>

      {/* CSV アップロード */}
      <div className="border rounded-md p-3 mb-4 space-y-3">
        <Label className="text-sm font-semibold">引落不可CSV</Label>
        <input type="file" accept=".csv"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          className="block text-sm"
        />
        {fileName && <p className="text-xs text-muted-foreground">読み込み済: {fileName}</p>}

        {csvRows && csvRows.length > 0 && (
          <div className="space-y-2">
            <div>
              <Label className="text-xs">利用者番号 列を選択</Label>
              <select className="w-full border rounded px-2 py-1 text-sm bg-background"
                value={clientColIdx ?? ""} onChange={(e) => setClientColIdx(e.target.value ? parseInt(e.target.value, 10) : null)}>
                <option value="">列を選択…</option>
                {csvRows[0].map((h, i) => (
                  <option key={i} value={i}>{i + 1}: {h || "(名前なし)"} — サンプル: {csvRows[1]?.[i] ?? ""}</option>
                ))}
              </select>
            </div>

            <div className="text-xs text-muted-foreground border-t pt-2">
              <p className="font-medium mb-1">プレビュー</p>
              <ul className="list-disc ml-4 space-y-0.5">
                <li>CSV行数（ヘッダ除く）: <b>{csvRows.length - 1}</b> 件</li>
                <li>抽出した利用者番号: <b>{csvClientNumbers.size}</b> 件</li>
                <li>対象の invoiced/overdue: <b>{preview.total}</b> 件</li>
                <li className="text-red-700">→ <b>overdue</b> に遷移: <b>{preview.unpaidCount}</b> 件</li>
                <li className="text-green-700">→ <b>paid</b> に自動遷移: <b>{preview.paidCount}</b> 件</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <Button onClick={handleExecute} disabled={busy || done || clientColIdx == null || invoicedRows.length === 0}>
        {busy ? "処理中…" : done ? "取り込み完了" : "この内容で取り込み実行"}
      </Button>

      <div className="mt-6 text-[11px] text-muted-foreground space-y-0.5">
        <p>・CSV は UTF-8 / Shift-JIS のどちらでも自動判別します。</p>
        <p>・不可リスト以外の利用者は全て「引落成功」とみなして paid に遷移させます（銀行仕様: 成功は黙認、不可のみ通知）。</p>
        <p>・対象月の status が invoiced または overdue でない行は触りません（paid / cancelled は影響なし）。</p>
      </div>
    </div>
  );
}
