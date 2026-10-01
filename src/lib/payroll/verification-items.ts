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
  absenceDeduction,
  shoninshaAdjustmentOf,
  hourlyTenureOrQualification,
  type HourlyPayroll,
  type MonthlyPayroll,
  type OvertimeSetting,
} from "./payroll-calc";

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** 分で持っている項目 (金額ではない)。② の値は soukatsuMinutes で読む */
export const MINUTE_ITEMS = new Set(["出勤時間"]);

/**
 * ② が 初任者研修費を 本人給の欄に入れているか。★ 入れている人だけ 当方も本人給に足す。
 * ★ 検査 (check:part-item-sum) も ourItems を直接呼ぶので、★ 逐語コピーを作らないよう関数にした。
 */
export function shoninshaInSoukatsuOf(row: Record<string, unknown>): boolean {
  return pickSoukatsu(row, "初任者研修費") + pickSoukatsu(row, "初任者研修調整費") > 0;
}

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
      // ★ 初任者研修調整費 (無資格の減額) は ② では **本人給に畳み込まれている**。
      //   別に「初任者研修調整費」列もあるが 表示だけで 総支給には足されていない。
      //   実測 (2026-10-01 / ★ 分母 = 調整費 ≠ 0 の 13 人月): 引くと 12 一致 / 引かないと 0 一致。
      //   ★ 引かないと 当方の 12 項目の和 が grand_total を 調整費ぶん超える (grand_total は引いている)。
      { item: "本人給", ours: num(e.totalPay) + num(e.office_work_pay) + num(e.cancel_allowance)
        + weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e as never), num(e.weekend_holiday_rate))
        + num(e.tokubi_allowance) + (shoninshaInSoukatsu ? num(e.shoninsha_pay) : 0)
        - shoninshaAdjustmentOf(e as unknown as HourlyPayroll) },
      { item: "土日祝", ours: weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e as never), num(e.weekend_holiday_rate)) },
      { item: "移動手当", ours: num(e.travel_allowance) },
      { item: "有給休暇手当", ours: num(e.paid_leave_allowance) },
      { item: "通信手当", ours: num(e.communication_fee) },
      { item: "通勤費", ours: num(e.commute_fee) },
      { item: "出張費", ours: num(e.business_trip_fee) },
      { item: "ドタキャン", ours: num(e.cancel_allowance) },
      { item: "特日", ours: num(e.tokubi_allowance) },
      // ⚠ ★ 「調整手当(内訳計)」は **提責_社員シート専用**。★ パートシートに当ててはいけない (2026-10-01)。
      //   ② 側は soukatsuAdjustmentParts = 介護 + ・夜朝・深夜 + ・特日 − 誤差 だが、
      //   ★ パートシートには その 3 列が 1 列も無い (実測 2,489 行すべて)。★ 必ず 0 になり、
      //   ★ 当方の特日手当が まるごと「不一致」に化けていた (232 人月 ¥253,418)。
      //   ★ しかも 同じ値を 1 つ上の「特日」行で既に比べている (パートは「特日」列 / 社員は「・特日」列)。
      //     実測: sheet_kind=part 2,489 行 … 特日 2,489 / ・特日 0 / 介護 0 / ・夜朝・深夜 0
      //           sheet_kind=shaseki 1,326 行 … 特日 0 / ・特日 1,326 / 介護 1,326 / ・夜朝・深夜 1,326
      { item: "残業総額", ours: num(e.overtime_pay) + num(e.legal_holiday_pay) },
      { item: "育児手当", ours: num(e.childcare_allowance) },
      { item: "調整手当", ours: num(e.error_adjustment) },
      { item: "処遇改善補助金手当", ours: num(e.treatment_subsidy) },
      // ② の「初任者研修調整費」は 負の数 (−3,425 等)。当方は 引く額を正の数で持つので 符号を合わせる (2026-09-27)
      { item: "初任者研修調整費", ours: -shoninshaAdjustmentOf(e as unknown as HourlyPayroll) },
      // ★ ② のパートの 総支給の式に入るのに 1 度も比べていなかった 2 列 (2026-10-01 実測)。
      //   ② 総支給額 = 本人給 + 通勤費 + 有給休暇手当 + 出張費 + 通信手当 + 移動手当
      //              + ★その他手当 + ★勤続手当 + 処遇改善補助金手当 + 残業総額 + 調整手当 + 育児手当
      //   で 2,255 / 2,327 人月 (96.9%) が 1 円一致する (貪欲探索で列を 1 本ずつ足して実測)。
      //   ★ 足して見えるようになるのは 勤続 17 人月 ¥63,592 / その他 49 人月 ¥535,236。
      //     うち 36 人月 ¥74,419 は この 2 列だけで 総支給の差が説明できる。
      // ⚠ 勤続手当は settings.tenure_allowance ではなく **hourlyTenure()** で出す。
      //   settings の値は時給者には入っておらず、0 と読むと 729 人月の偽陽性になる (実際に 1 度出した)。
      //   ★ hourlyTenure が見るのは 訪問時間(同行除く) であって 出勤時間ではない。
      //   ★ 資格手当 (廃止された制度の残骸) がある人は 勤続手当を出さない (排他)。
      //     ② の列名「資格or勤続手当」がそれを表している (user 2026-10-01)
      { item: "勤続手当", ours: hourlyTenureOrQualification(e as unknown as HourlyPayroll) },
      // ⚠ training_pay は **初任者研修ぶんを既に含む** (page.tsx: trainingMinutes + shoninshaMinutes)。
      //   ② は初任者研修費を **本人給だけ** に入れるので、本人給に足したぶんは ここから引く。
      //   ★ 引かないと 当方の 12 項目の和 が grand_total を 26 人月で超える (二重計上。2026-10-01 実測)。
      //   実例 杉尾加奈子 1271500942|260603|202606: ② その他手当 0 / 初任者研修費 64,975 に対し
      //        当方は その他手当 64,975 + 本人給にも 64,975 を足していた
      { item: "その他手当", ours: num(e.training_pay) + num(e.meeting_fee)
        - (shoninshaInSoukatsu ? num(e.shoninsha_pay) : 0) },
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
    // ★ 欠勤控除は 2026-09-18 に実装して monthlyGrandTotal で引いているのに、
    //   ★ 検証項目に入っていなかった (2026-10-01 に気付いた)。② にも列がある (1,326 行中 34 行)。
    //   ★ 足すと 5 人月が見えるようになる: 佐瀨恵子 202606 (当方だけ引いている) /
    //     坂尾沙織 202607 (② だけ -18,333 で 当方の欠勤日数は 0) / 川嶋由希子 202603 (47円) ほか。
    //   ★ ② は 遅刻早退金額と同じく 負の数で持つので 符号を合わせる。
    { item: "欠勤控除", ours: -absenceDeduction(p) },
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
  const items = ourItems(e, kind, otSettings, shoninshaInSoukatsuOf(row))
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
