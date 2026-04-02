"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import {
  calcDayRoute, collectAddressPairs, mToKm, secToHm,
  type VisitForRoute, type DayRouteResult,
} from "@/lib/distance-calculator";

type Office = { id: string; name: string; office_number: string };
type Employee = { id: string; employee_number: string; name: string; address: string; office_id: string };
type Client = { client_number: string; address: string };

type EmployeeResult = {
  employee: Employee;
  commute_m: number;
  travel_m: number;
  travel_sec: number;
  days: DayRouteResult[];
};

function formatProcessingMonth(m: string) {
  if (!m) return "";
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}

export default function DistancePage() {
  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState("");
  const [months, setMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<EmployeeResult[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  type DebugInfo = { pairsSent: number; resultsGot: number; sampleOrigin?: string; sampleDest?: string; uncachedCount?: number; apiKeySet?: boolean; apiKeyLen?: number; googleStatus?: string; apiSample?: { origin: string; destination: string; dist: number }[] };
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);

  useEffect(() => {
    supabase.from("offices").select("id,name,office_number").order("name").then(({ data }) => {
      if (!data) return;
      setOffices(data as Office[]);
      if (data.length === 1) setSelectedOfficeId((data as Office[])[0].id);
    });
    supabase.from("service_records").select("processing_month").limit(100000).then(({ data }) => {
      if (!data) return;
      const unique = [...new Set(data.map((r: { processing_month: string }) => r.processing_month))].sort().reverse();
      setMonths(unique);
      if (unique.length > 0) setSelectedMonth(unique[0]);
    });
  }, []);

  async function calculate() {
    if (!selectedOfficeId || !selectedMonth) { toast.error("事業所と処理月を選択してください"); return; }
    setLoading(true); setResults([]); setExpanded(null);

    try {
      const office = offices.find((o) => o.id === selectedOfficeId)!;

      // 1. 職員取得
      setProgress("職員情報を取得中...");
      const { data: empData } = await supabase
        .from("employees")
        .select("id,employee_number,name,address,office_id")
        .eq("office_id", selectedOfficeId)
        .neq("employment_status", "退職者");
      const employees = (empData ?? []) as Employee[];
      const empWithAddress = employees.filter((e) => e.address?.trim());
      if (empWithAddress.length === 0) { toast.error("住所が登録されている職員がいません"); return; }

      // 2. 利用者住所マップ
      setProgress("利用者情報を取得中...");
      const { data: clientData } = await supabase
        .from("clients")
        .select("client_number,address")
        .eq("office_id", selectedOfficeId);
      const clientMap = new Map((clientData ?? []).map((c: Client) => [c.client_number, c.address]));

      // 3. サービス実績取得（ページング）
      setProgress("サービス実績を取得中...");
      const allRecords: { employee_number: string; service_date: string; client_number: string; dispatch_start_time: string; dispatch_end_time: string }[] = [];
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("service_records")
          .select("employee_number,service_date,client_number,dispatch_start_time,dispatch_end_time")
          .eq("processing_month", selectedMonth)
          .eq("office_number", office.office_number)
          .order("id")
          .range(from, from + pageSize - 1);
        if (!data || data.length === 0) break;
        allRecords.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (allRecords.length === 0) { toast.error("該当するサービス実績がありません"); return; }

      // 4. 職員×日別にグループ化
      const empNumToEmp = new Map(empWithAddress.map((e) => [e.employee_number, e]));
      type DayMap = Map<string, VisitForRoute[]>;
      const byEmpDay = new Map<string, DayMap>();

      for (const rec of allRecords) {
        const emp = empNumToEmp.get(rec.employee_number);
        if (!emp) continue;
        const clientAddr = clientMap.get(rec.client_number);
        if (!clientAddr?.trim()) continue;

        if (!byEmpDay.has(emp.id)) byEmpDay.set(emp.id, new Map());
        const dayMap = byEmpDay.get(emp.id)!;
        if (!dayMap.has(rec.service_date)) dayMap.set(rec.service_date, []);
        dayMap.get(rec.service_date)!.push({
          client_number: rec.client_number,
          client_address: clientAddr,
          dispatch_start_time: rec.dispatch_start_time,
          dispatch_end_time: rec.dispatch_end_time,
        });
      }

      // 5. 必要な全アドレスペアを収集
      setProgress("距離データを取得中（初回のみ時間がかかります）...");
      const allPairs: { origin: string; destination: string }[] = [];
      for (const [empId, dayMap] of byEmpDay) {
        const emp = empWithAddress.find((e) => e.id === empId)!;
        allPairs.push(...collectAddressPairs(emp.address, dayMap));
      }

      // 6. /api/distance でキャッシュ込み距離取得
      setProgress(`距離を取得中... (${allPairs.length}ペア)`);
      if (allPairs.length === 0) {
        toast.error("距離計算できるデータがありません。利用者の住所が登録されているか確認してください。");
        return;
      }
      const res = await fetch("/api/distance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: allPairs }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`距離APIエラー (${res.status}): ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      if (json.error) throw new Error(`距離APIエラー: ${json.error}`);
      const distResults: { origin: string; destination: string; distance_meters: number; duration_seconds: number }[] = json.results ?? [];
      const _debug: { uncachedCount?: number; apiKeySet?: boolean; apiKeyLen?: number; googleStatus?: string; sample?: { origin: string; destination: string; dist: number }[] } | undefined = json._debug;

      setDebugInfo({
        pairsSent: allPairs.length,
        resultsGot: distResults.length,
        sampleOrigin: allPairs[0]?.origin?.slice(0, 60),
        sampleDest: allPairs[0]?.destination?.slice(0, 60),
        uncachedCount: _debug?.uncachedCount,
        apiKeySet: _debug?.apiKeySet,
        apiKeyLen: _debug?.apiKeyLen,
        googleStatus: _debug?.googleStatus,
        apiSample: _debug?.sample,
      });

      if (distResults.length === 0) {
        toast.error(`Google APIから距離が取得できませんでした（${allPairs.length}ペアを送信）。Distance Matrix APIが有効か、APIキーの制限を確認してください。`);
        return;
      }
      toast.info(`${distResults.length}/${allPairs.length}ペアの距離を取得しました`);
      const distMap = new Map<string, { distance_meters: number; duration_seconds: number }>(
        distResults.map((r) => [`${r.origin}|||${r.destination}`, { distance_meters: r.distance_meters, duration_seconds: r.duration_seconds }])
      );

      // 7. 計算
      setProgress("計算中...");
      const empResults: EmployeeResult[] = [];
      for (const [empId, dayMap] of byEmpDay) {
        const emp = empWithAddress.find((e) => e.id === empId)!;
        const days: DayRouteResult[] = [];
        let commute_m = 0, travel_m = 0, travel_sec = 0;

        for (const [date, visits] of dayMap) {
          const day = calcDayRoute(date, emp.address, visits, distMap);
          if (!day) continue;
          days.push(day);
          commute_m += day.commute_distance_m;
          travel_m += day.travel_distance_m;
          travel_sec += day.travel_time_sec;
        }

        if (days.length > 0) {
          days.sort((a, b) => a.date.localeCompare(b.date));
          empResults.push({ employee: emp, commute_m, travel_m, travel_sec, days });
        }
      }

      empResults.sort((a, b) => a.employee.employee_number.localeCompare(b.employee.employee_number));
      setResults(empResults);
      if (empResults.length === 0) toast.error("計算できるデータがありませんでした");
      else toast.success(`${empResults.length}名分の計算が完了しました`);
    } catch (e) {
      toast.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false); setProgress("");
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">移動距離計算</h2>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium whitespace-nowrap">事業所</label>
              <select className="border rounded px-3 py-1.5 text-sm bg-background" value={selectedOfficeId} onChange={(e) => setSelectedOfficeId(e.target.value)}>
                <option value="">選択</option>
                {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium whitespace-nowrap">処理月</label>
              <select className="border rounded px-3 py-1.5 text-sm bg-background" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
                {months.length === 0 && <option value="">（データなし）</option>}
                {months.map((m) => <option key={m} value={m}>{formatProcessingMonth(m)}</option>)}
              </select>
            </div>
            <Button onClick={calculate} disabled={!selectedOfficeId || !selectedMonth || loading}>
              {loading ? progress || "計算中..." : "距離を計算"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            ※ 初回は住所ペアごとにGoogle APIを呼び出すため時間がかかります。2回目以降はキャッシュから取得されます。
          </p>
        </CardContent>
      </Card>

      {debugInfo && (
        <Card className="mb-4 border-yellow-400">
          <CardContent className="pt-4 text-xs font-mono space-y-1">
            <p className="font-bold text-yellow-700">【診断情報】</p>
            <p>送信ペア数: {debugInfo.pairsSent} / API取得数: {debugInfo.resultsGot} / うち未キャッシュ: {debugInfo.uncachedCount ?? "?"}</p>
            <p>APIキー設定: {debugInfo.apiKeySet === undefined ? "?" : debugInfo.apiKeySet ? `あり (${debugInfo.apiKeyLen}文字)` : "なし（未設定）"}</p>
            {debugInfo.googleStatus && <p>Google APIステータス: {debugInfo.googleStatus}</p>}
            <p>サンプル origin: {debugInfo.sampleOrigin ?? "（なし）"}</p>
            <p>サンプル dest: {debugInfo.sampleDest ?? "（なし）"}</p>
            {debugInfo.apiSample && debugInfo.apiSample.length > 0 && (
              <div>
                <p>APIサンプル結果:</p>
                {debugInfo.apiSample.map((s, i) => (
                  <p key={i} className="pl-2">{s.origin.slice(0, 30)}→{s.destination.slice(0, 30)} = {s.dist}m</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground mb-2">
            {formatProcessingMonth(selectedMonth)} / {offices.find((o) => o.id === selectedOfficeId)?.name} — {results.length}名
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>職員名</TableHead>
                <TableHead className="text-right">通勤距離（API）</TableHead>
                <TableHead className="text-right">移動距離</TableHead>
                <TableHead className="text-right">移動時間</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <>
                  <TableRow
                    key={r.employee.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpanded(expanded === r.employee.id ? null : r.employee.id)}
                  >
                    <TableCell className="font-medium">{r.employee.name}</TableCell>
                    <TableCell className="text-right font-mono">{mToKm(r.commute_m)} km</TableCell>
                    <TableCell className="text-right font-mono">{mToKm(r.travel_m)} km</TableCell>
                    <TableCell className="text-right font-mono">{secToHm(r.travel_sec)}</TableCell>
                    <TableCell className="text-center text-muted-foreground text-xs">
                      {expanded === r.employee.id ? "▲" : "▼"}
                    </TableCell>
                  </TableRow>
                  {expanded === r.employee.id && r.days.map((day) => (
                    <TableRow key={`${r.employee.id}-${day.date}`} className="bg-muted/20 text-sm">
                      <TableCell className="pl-8 text-muted-foreground">{day.date}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{mToKm(day.commute_distance_m)} km</TableCell>
                      <TableCell className="text-right font-mono text-xs">{mToKm(day.travel_distance_m)} km</TableCell>
                      <TableCell className="text-right font-mono text-xs">{secToHm(day.travel_time_sec)}</TableCell>
                      <TableCell>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          {day.legs.map((leg, i) => (
                            <div key={i} className={leg.gap_excluded ? "line-through opacity-40" : ""}>
                              {mToKm(leg.distance_m)}km
                              {leg.is_home_leg ? " (自宅)" : ""}
                              {leg.gap_excluded ? " (2h空)" : ""}
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
