import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">ダッシュボード</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              事業所数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">-</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              職員数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">-</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              利用者数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">-</div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>最近の取り込み</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            まだデータが取り込まれていません。CSV取り込みページからデータを登録してください。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
