/**
 * 検証ページ (/verification) の「当システムの値 と 総括表 ② の値」を 項目ごとに組み立てる (2026-09-27 給与D が切り出し)。
 * verification-content.tsx と scripts/check-kenmu-verification-gap.mts の両方がここを呼ぶ。
 * ★ 以前は ourItems が 2 か所にあり 写しの側に 初任者研修調整費・遅刻早退金額 が足されずに乖離していた。
 *
 * ★ ② の値の読み方: 金額の項目は pickSoukatsu (円)、★ 時間の項目 (MINUTE_ITEMS) は soukatsuMinutes (分)。
 *   pickSoukatsu は parseFloat なので "35:00" を 35、"174..00" を 174 と黙って読む。
 *   ★ 読めない値は 0 にせず unreadable に出す (呼び側が画面に「読めない」と表示する)。
 */
import { pickSoukatsu, hasSoukatsuColumn, soukatsuAdjustmentParts } from "./soukatsu-diff";
import { soukatsuMinutes } from "./soukatsu-time";
import {
  careOvertimePay,
  weekendAllowanceMinutes,
  weekendHolidayAllowanceAmount,
  commuteFeeAmount,
  monthlyPaidLeaveAllowance,
  overtimeExcessPay,
  travelFeeAmount,
  yochoAllowance,
  lateEarlyDeduction,
  shoninshaAdjustmentOf,
  type HourlyPayroll,
  type MonthlyPayroll,
  type OvertimeSetting,
} from "./payroll-calc";

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** 分で持っている項目 (金額ではない)。② の値は soukatsuMinutes で読む */
export const MINUTE_ITEMS = new Set(["出勤時間"]);

export /** 当システムの 1 人ぶんの値を 総括表の項目名に合わせて取り出す */
function ourItems(
  e: Record<string, unknown>,
  kind: "part" | "shaseki",
  otSettings: Map<string, OvertimeSetting>,
  /** 総括表の「初任者研修費」列に金額があるか。あるときだけ 本人給に足す */
  shoninshaInSoukatsu = false,
): { item: string; ours: number }[] {
  if (kind === "part") {
    return [
      { item: "総支給額", ours: num(e.grand_total) },
      { item: "集計項目小計", ours: num(e.totalPay) },
      // ⚠ 総括表のパートの「本人給」は 集計項目小計 そのものではなく、
      //   集計項目小計 + ドタキャン + 土日祝 + 特日 (2026-09-24 に 2,304 人月で実測。
      //   小計だけ 85.9% → ドタキャン・土日祝・特日 を足して 97.1% → 初任者研修費まで入れると 98.6%)。
      //   ★ 当方の「集計項目小計」(= totalPay) は 総括表と一致しているので、ずれていたのは この列の中身だけ
      // ★ 初任者研修費も本人給に含まれる。ただし **総括表の「初任者研修費」列がある人だけ**。
      //   研修・HRD研修は「その他手当」側で本人給には入らない。
      //   実測 (2026-09-25 / パート 2,294 人月): 足さないと 95.2% → 列がある人だけ足して **96.3%**
      //   (当方の初任者研修費を全員に足すと 95.3% にしかならない。橘真悟・伊藤瑠奈・春日晶子 は足さないほうが合う)
      { item: "本人給", ours: num(e.totalPay) + num(e.office_work_pay) + num(e.cancel_allowance)
        + weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e as never), num(e.weekend_holiday_rate))
        + num(e.tokubi_allowance) + (shoninshaInSoukatsu ? num(e.shoninsha_pay) : 0) },
      { item: "土日祝", ours: weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e as never), num(e.weekend_holiday_rate)) },
      { item: "移動手当", ours: num(e.travel_allowance) },
      { item: "有給休暇手当", ours: num(e.paid_leave_allowance) },
      { item: "通信手当", ours: num(e.communication_fee) },
      { item: "通勤費", ours: num(e.commute_fee) },
      { item: "出張費", ours: num(e.business_trip_fee) },
      { item: "ドタキャン", ours: num(e.cancel_allowance) },
      { item: "特日", ours: num(e.tokubi_allowance) },
      { item: "調整手当(内訳計)", ours: num(e.tokubi_allowance) },
      { item: "残業総額", ours: num(e.overtime_pay) + num(e.legal_holiday_pay) },
      { item: "育児手当", ours: num(e.childcare_allowance) },
      { item: "調整手当", ours: num(e.error_adjustment) },
      { item: "処遇改善補助金手当", ours: num(e.treatment_subsidy) },
      // ② の「初任者研修調整費」は 負の数 (−3,425 等)。当方は 引く額を正の数で持つので 符号を合わせる (2026-09-27)
      { item: "初任者研修調整費", ours: -shoninshaAdjustmentOf(e as unknown as HourlyPayroll) },
      { item: "出勤時間", ours: num((e.summary as Record<string, unknown> | undefined)?.workHoursMin) },
    ];
  }
  // 提責・社員。固定給は 給与設定 (settings) の値がそのまま出る
  const st = (e.settings ?? {}) as Record<string, unknown>;
  // ⚠ 月給者の 通勤費・出張費・介護超過・夜朝・有給・残業は **payload に額として入っていない**。
  //   payload の 1 件はそのまま MonthlyPayroll なので、給与画面と同じ関数を呼んで出す。
  //   2026-09-24 まで 出張費を e.business_trip_fee (画面で手入力する上乗せ欄・通常 0) から読んでいて、
  //   実際は一致している人を「要対応」に出していた (花見川 202605 で 9 名中 8 名が誤報)。
  //   ★ 逐語コピーは禁止 (片方だけ直すと乖離する)。必ず payroll-calc の関数を呼ぶこと
  const p = e as unknown as MonthlyPayroll;
  return [
    { item: "総支給額", ours: num(e.grand_total) },
    { item: "本人給", ours: num(st.base_personal_salary) },
    { item: "職能給", ours: num(st.skill_salary) },
    { item: "役職手当", ours: num(st.position_allowance) },
    { item: "資格手当", ours: num(st.qualification_allowance) },
    { item: "勤続手当", ours: num(st.tenure_allowance) },
    { item: "処遇改善手当", ours: num(st.treatment_improvement) },
    { item: "特別処遇改善手当", ours: num(st.specific_treatment_improvement) },
    { item: "処遇改善補助金手当", ours: num(st.treatment_subsidy) },
    { item: "固定残業代", ours: num(st.fixed_overtime_pay) },
    { item: "通勤費", ours: commuteFeeAmount(p) },
    // 出張費 = 距離 × 単価 (travelFeeAmount) + 画面で足した上乗せ (business_trip_fee)
    { item: "出張費", ours: travelFeeAmount(p) + num(e.business_trip_fee) },
    { item: "移動手当", ours: 0 },
    // ⚠ 総括表の「介護」列は 社員=介護超過手当 / 事務員=訪問分の給与 の **両方**が入る列。
    //   当方は別フィールドに分けているので 足して比べる (2026-09-24 実測: やわた 熊谷明日香 202608 は
    //   当方の office_worker_care_pay 40,852 が総括表と 1 円一致していたのに 偽陽性で出ていた)
    { item: "介護", ours: careOvertimePay(p) + num(e.office_worker_care_pay) },
    // ★ 総括表は 介護超過・夜朝・特日 を「調整手当」に畳み込む (2026-09-24 に 762 人月で実測・92.7% 一致)。
    //   当方はそれぞれ別項目なので、合計どうしで突合する。個別項目は参考表示として残す
    { item: "調整手当(内訳計)", ours: careOvertimePay(p) + num(e.office_worker_care_pay)
      + yochoAllowance(p) + num(e.tokubi_allowance) },
    { item: "夜朝深夜", ours: yochoAllowance(p) },
    { item: "有給休暇手当", ours: monthlyPaidLeaveAllowance(p) },
    { item: "残業総額", ours: overtimeExcessPay(p, otSettings) },
    { item: "育児手当", ours: num(e.childcare_allowance) },
    { item: "調整手当", ours: num(e.adjustment) },
    { item: "特日", ours: num(e.tokubi_allowance) },
    // ② の「遅刻早退金額」は 負の数で入っている (−660 等)。当方は 控除額を正の数で持つので 符号を合わせる (2026-09-27)
    { item: "遅刻早退金額", ours: -lateEarlyDeduction(p) },
    { item: "出勤時間", ours: num((e.summary as Record<string, unknown> | undefined)?.workHoursMin) },
  ];
}

/**
 * 当システムの項目と ② の値を並べる。② に列が無い項目は落とす (「調整手当(内訳計)」は ② の内訳の合計と比べる)。
 * 読めない ② の値は items に入れず unreadable に出す。
 */
export function verificationItems(
  e: Record<string, unknown>,
  kind: "part" | "shaseki",
  otSettings: Map<string, OvertimeSetting>,
  row: Record<string, unknown>,
): { items: { item: string; ours: number; soukatsu: number }[]; unreadable: { item: string; raw: unknown }[] } {
  const parts = soukatsuAdjustmentParts(row);
  const unreadable: { item: string; raw: unknown }[] = [];
  const items = ourItems(e, kind, otSettings, pickSoukatsu(row, "初任者研修費") + pickSoukatsu(row, "初任者研修調整費") > 0)
    .filter((x) => x.item === "調整手当(内訳計)" || hasSoukatsuColumn(row, x.item))
    .flatMap((x) => {
      if (x.item === "調整手当(内訳計)") return [{ ...x, soukatsu: parts.total }];
      // ★ 月給の法内残業: 当方は computeOvertimePay の中 (= 残業総額) に入れるが、② は「法内残業手当」の別の列で払う。
      //   ② の 残業総額 だけと比べると お金は合っているのに不一致に出る (2026-09-27 給与D: 小原 1271500942|438|202606
      //   総支給 ②=当方=271,807 / 江尻 917|202605 の差 2,818 = 法内残業手当)。★ 足して比べる
      if (x.item === "残業総額" && kind === "shaseki") return [{ ...x, soukatsu: pickSoukatsu(row, "残業総額") + pickSoukatsu(row, "法内残業手当") }];
      if (!MINUTE_ITEMS.has(x.item)) return [{ ...x, soukatsu: pickSoukatsu(row, x.item) }];
      const raw = row[x.item];
      const m = soukatsuMinutes(raw, "minutes");
      if (m === null) { unreadable.push({ item: x.item, raw }); return []; }
      return [{ ...x, soukatsu: m }];
    })
    // 調整手当が無い人月は 内訳計の行を出さない (0 対 0 のノイズを避ける)
    .filter((x) => !(x.item === "調整手当(内訳計)" && parts.total === 0 && x.ours === 0));
  return { items, unreadable };
}
