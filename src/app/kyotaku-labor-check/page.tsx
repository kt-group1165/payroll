import { KyotakuLaborCheckContent } from "./kyotaku-labor-check-content";

/**
 * /kyotaku-labor-check
 * 居宅介護支援 労働時間チェック画面。
 *
 * その月の出勤簿を全 居宅介護支援職員で集計し、以下のいずれかが
 * 発生している人だけ一覧表示する:
 *   - 週 40h に満たない (= 欠勤あり)
 *   - 日次残業あり (8h 超勤)
 *   - 週次残業あり (週 40h 超勤)
 *
 * 各行から「編集」ボタンで /kyotaku-attendance?office=&employee=&month= に飛ぶ。
 */
export default function KyotakuLaborCheckPage() {
  return <KyotakuLaborCheckContent />;
}
