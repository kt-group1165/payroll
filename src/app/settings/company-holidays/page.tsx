import { CompanyHolidaysContent } from "./company-holidays-content";

/**
 * /settings/company-holidays
 * 会社休日 (お盆 / 年末年始 等、祝日以外の独自休業日) 管理画面。
 *
 * Server Component: 直接 client component を render するだけの shell。
 * 一覧 / 追加 / 削除 / デフォルト復元は client 側で SWR 経由で操作。
 */
export default function CompanyHolidaysSettingsPage() {
  return <CompanyHolidaysContent />;
}
