import Link from "next/link";

export default function OfficeIndexPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">事業所管理</h2>
      <p className="text-sm text-muted-foreground mb-6">
        事業所で使うメニュー一覧です。職員情報・利用者情報の管理ができます。
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-xl">
        <Link
          href="/office/employees"
          className="border rounded-md p-6 hover:bg-muted/40 transition-colors"
        >
          <div className="text-3xl mb-2">👥</div>
          <div className="font-bold">職員一覧</div>
          <p className="text-sm text-muted-foreground mt-1">
            職員情報の閲覧・登録・編集
          </p>
        </Link>
        <Link
          href="/office/clients"
          className="border rounded-md p-6 hover:bg-muted/40 transition-colors"
        >
          <div className="text-3xl mb-2">📋</div>
          <div className="font-bold">利用者一覧</div>
          <p className="text-sm text-muted-foreground mt-1">
            利用者情報の閲覧・登録・編集
          </p>
        </Link>
      </div>
    </div>
  );
}
