/**
 * /settings/rules 計算の決まり (2026-10-08 user「計算に使うものは基本設定画面で見れるようにして」)
 *
 * 職員・事業所・法人の設定画面に出てこず コードの中にだけある 決まりの値を 1 枚にまとめて見せる。
 * ★ 値はコードの定数をそのまま読んで出す (この画面に書き写さない。書き写すと片方だけ直したときにずれる)。
 * 事業所ごとに違う設定 (アプリ設定) は /settings/history に 何月分から の履歴つきで出ている。
 */
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  TENURE_RULES, CARE_HOURS_075_FACTOR, MONTHLY_OT_THRESHOLD_MIN, OVERTIME_RATE, OVERTIME_RATE_OVER_60H,
  MONTHLY_SCHEDULED_HOURS, OFFICE_WORKER_SCHEDULED_HOURS, CHILDCARE_RULES, VISIT_TIME_PERIOD_RATES,
  COMMUNICATION_FEE_TIERS, DOUKOU_SERVICE_CODES, TOKUBI_RATE_BY_HOLIDAY_NAME,
} from "@/lib/payroll/payroll-calc";
import { CARE_HOURS_075_CODES } from "@/lib/payroll/care-hours-075";
import { JUHO_SHORT_VISIT_MAX_MINUTES } from "@/lib/payroll/visit-pay";
import { GAP_THRESHOLD_MIN, TRAVEL_TIME_THRESHOLD_SEC } from "@/lib/distance-calculator";
import { japaneseHolidaysOf } from "@/lib/payroll/japan-holidays";
import { MONEY_SETTING_LABELS } from "@/lib/app-settings";
import { currentMonthJst } from "@/lib/payroll/office-price-revision";

// 祝日を「今年・来年」で出すので 開くたびに作る (build 時に固定しない)
export const dynamic = "force-dynamic";

const yen = (n: number) => `${n.toLocaleString()}円`;

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-4">
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        <div className="text-sm">{children}</div>
        {note && <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <table className="text-sm">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b last:border-0">
            <td className="py-1 pr-6 text-muted-foreground whitespace-nowrap">{k}</td>
            <td className="py-1">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RulesPage() {
  const year = Number(currentMonthJst().slice(0, 4));
  const holidays = [year, year + 1].map((y) => ({ y, list: [...japaneseHolidaysOf(y)].sort(([a], [b]) => a.localeCompare(b)) }));

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h2 className="text-2xl font-bold">計算の決まり</h2>
        <p className="text-sm text-muted-foreground">
          給与計算に使う決まりのうち、職員・事業所・法人の設定画面に出てこないものです (計算の中身の値をそのまま出しています)。
          変えたいときは 開発側に依頼してください。事業所ごとに違う設定は <Link href="/settings/history" className="underline">設定の履歴</Link>、
          職員ごとの金額は 職員一覧の編集 (給与タブ)、事業所の単価は 事業所一覧 で見られます。
        </p>
      </div>

      <Section title="勤続手当">
        <Rows rows={[
          ["社員 (月給)", <>1 年目 {yen(TENURE_RULES.monthlyFirstYear)}/月、以降 1 年ごとに +{yen(TENURE_RULES.monthlyPerYear)}</>],
          ["パート 訪問介護・訪問看護", <>{TENURE_RULES.visitBase}円/時 + 5 年ごとに +{TENURE_RULES.visitPer5Years}円/時 (訪問時間 × 単価)</>],
          ["パート 訪問入浴", <>5 年ごとの段 × {TENURE_RULES.bathPer5Years}円/件</>],
          ["非常勤 居宅介護支援", <>5 年ごとの段 × {TENURE_RULES.kyotakuPer5Years}円/件</>],
          ["対象", "勤続手当の資格 (介護福祉士 / 実務者研修修了 / 介護支援専門員) がある人。資格を取った日があれば その月から"],
          ["勤続の月数", "職員一覧の「グループ通算の勤続」(いつ時点か + 以後 1 か月ごとに 1)。月給の節目は グループ通算と法人の長い方"],
        ]} />
      </Section>

      <Section title="残業">
        <Rows rows={[
          ["割増", <>月 {MONTHLY_OT_THRESHOLD_MIN / 60} 時間までは ×{OVERTIME_RATE}、超えた分は ×{OVERTIME_RATE_OVER_60H}</>],
          ["月の所定時間 (欠勤控除・日割りの 1 時間あたり)", <>月給 {MONTHLY_SCHEDULED_HOURS} 時間 / 事務員 {OFFICE_WORKER_SCHEDULED_HOURS} 時間</>],
          ["残業単価の元にする手当", "給与設定 → 残業設定 (職種ごと・履歴あり)"],
        ]} />
      </Section>

      <Section title="訪問の時給・時間" note={<>0.75 を掛けるサービスコード: {[...CARE_HOURS_075_CODES].sort().join(" / ")}</>}>
        <Rows rows={[
          ["時間帯の割増 (同行には付けない)", <>深夜 ×{VISIT_TIME_PERIOD_RATES.深夜} / 夜朝・夜間・早朝 ×{VISIT_TIME_PERIOD_RATES.夜朝}</>],
          ["介護時間で 0.75 掛けにするサービス", <>×{CARE_HOURS_075_FACTOR} (下のコード)</>],
          ["同行として扱うサービスコード", [...DOUKOU_SERVICE_CODES].join(" / ")],
          ["重度訪問の短時間", <>{JUHO_SHORT_VISIT_MAX_MINUTES} 分以下の訪問 (時給は 事業所ごとの設定)</>],
        ]} />
      </Section>

      <Section title="移動">
        <Rows rows={[
          ["移動とみなさない間隔", <>前の訪問の終わりから次の訪問まで {GAP_THRESHOLD_MIN} 分を超えたら 移動に数えない</>],
          ["移動時間に数える分", <>1 区間 {TRAVEL_TIME_THRESHOLD_SEC / 60} 分を超えた分だけ (15 分以内の移動は 0)</>],
          ["移動手当の単価", "事業所一覧 (円/分)"],
        ]} />
      </Section>

      <Section title="通信手当">
        <Rows rows={[
          ["その月の訪問時間 → 金額", COMMUNICATION_FEE_TIERS.map((t) => `${t.fromHours} 時間以上 ${yen(t.yen)}`).join(" / ") + " (0 時間は 0 円)"],
          ["社保加入の人", "標準は 0 円 (職員ごとに「社保加入でも時間で払う」「スマホ貸与」などを選べる)"],
        ]} />
      </Section>

      <Section title="育児手当 (旧システムの契約が無いとき)">
        <Rows rows={[
          ["上限", <>子 1 人 {yen(CHILDCARE_RULES.limitOne)} / 2 人以上 {yen(CHILDCARE_RULES.limitTwoOrMore)}</>],
          ["割合", <>保育料の {CHILDCARE_RULES.rate * 100}% (幼稚園は {CHILDCARE_RULES.rateKindergarten * 100}%)</>],
          ["時給者の按分", <>月の訪問時間 ÷ {CHILDCARE_RULES.fullHours} 時間 (上限 1)</>],
        ]} />
      </Section>

      <Section title="特日手当" note="祝日は祝日法の決まりから計算しています (振替休日・国民の休日を含む)。会社休日は 設定 → 会社休日">
        <Rows rows={[
          ["単価", Object.entries(TOKUBI_RATE_BY_HOLIDAY_NAME).map(([k, v]) => `${k} ${v}円/時`).join(" / ")],
          ["対象の日", "設定 → 会社休日 で「お盆」「年末年始」と名前を付けた日"],
        ]} />
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {holidays.map(({ y, list }) => (
            <div key={y}>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{y}年の祝日</p>
              <ul className="text-xs leading-5">
                {list.map(([d, name]) => <li key={d}><span className="font-mono">{d}</span> {name}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section title="事業所ごとに違う設定 (何月分から の履歴つき)">
        <ul className="list-disc pl-5 text-sm">
          {Object.values(MONEY_SETTING_LABELS).map((l) => <li key={l}>{l}</li>)}
        </ul>
        <p className="mt-2 text-sm"><Link href="/settings/history" className="underline">設定の履歴</Link> で 中身と変わった月を見られます。</p>
      </Section>
    </div>
  );
}
