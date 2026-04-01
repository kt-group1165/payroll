import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PayrollPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">給与計算</h2>
      <Card>
        <CardHeader>
          <CardTitle>準備中</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            給与計算機能は今後実装予定です。まずはCSV取り込みとマスタデータの登録を行ってください。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
