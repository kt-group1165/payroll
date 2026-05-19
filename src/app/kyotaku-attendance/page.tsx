import { Suspense } from "react";
import { KyotakuAttendanceContent } from "@/components/payroll/kyotaku-attendance-content";

/**
 * /kyotaku-attendance
 * 居宅介護支援ケアマネ用 出勤簿 入力画面。
 *
 * Server Component: 直接 client component を render するだけの shell。
 * office / employee の fetch は client 側で dropdown 選択時に行う方が
 * UX が良いため、ここでは初期 fetch を行わない。
 *
 * 子で useSearchParams を使うため Next.js 仕様に従い Suspense boundary を挟む。
 */
export default function KyotakuAttendancePage() {
  return (
    <Suspense fallback={null}>
      <KyotakuAttendanceContent />
    </Suspense>
  );
}
