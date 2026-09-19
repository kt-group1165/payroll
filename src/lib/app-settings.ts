import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * payroll_app_settings (key/value) の read/write helper。
 *
 * jisseki_source_mode = 実績データ (給与明細) の取込元モード:
 *   - "csv"   … ほのぼの CSV 取込 (従来)
 *   - "kaigo" … kaigo-app 直接モード (= 取り込みボタン押下時に snapshot pull。
 *               リアルタイム JOIN 参照はしない — 給与確定後の金額変動事故を防ぐ)
 */
export type JissekiSourceMode = "csv" | "kaigo";

/**
 * 土日祝手当の時給 (事業所番号 → 円/時)。無い事業所は 50円。
 * 総括表 2026-07: Hana系 (花見川・船橋・おゆみ野・高品・中央・さつき・八千代・四街道) は 50円、
 * いすみ・山武・東郷・大網・茂原・市原・KT姉崎・姉崎ムツミ・五井・木更津・ちはら台・袖ケ浦・君津・やわた は 100円 (当方50円のちょうど2倍)。
 */
export const WEEKEND_HOLIDAY_RATES_KEY = "weekend_holiday_allowance_rates";

/** 介護超過の下の段 (事業所番号 → { from_hours, unit_price })。社員の 100〜120h × 800円 の事業所 */
export const CARE_OVERTIME_LOWER_TIERS_KEY = "care_overtime_lower_tiers";
export type CareOvertimeLowerTier = { from_hours: number; unit_price: number };

export async function getCareOvertimeLowerTiers(supabase: SupabaseClient): Promise<{ tiers: Record<string, CareOvertimeLowerTier>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", CARE_OVERTIME_LOWER_TIERS_KEY).maybeSingle();
  if (error) return { tiers: {}, error: error.message };
  return { tiers: ((data?.value as { tiers?: Record<string, CareOvertimeLowerTier> } | null)?.tiers) ?? {}, error: null };
}

/** sunday_holiday_only = 土曜を含まず 実績の休日区分 日祭・休日 だけを対象にする事業所番号 */
export async function getWeekendHolidayRates(supabase: SupabaseClient): Promise<{ rates: Record<string, number>; sundayHolidayOnly: Set<string>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", WEEKEND_HOLIDAY_RATES_KEY).maybeSingle();
  if (error) return { rates: {}, sundayHolidayOnly: new Set(), error: error.message };
  const v = data?.value as { rates?: Record<string, number>; sunday_holiday_only?: string[] } | null;
  return { rates: v?.rates ?? {}, sundayHolidayOnly: new Set(v?.sunday_holiday_only ?? []), error: null };
}

/**
 * 会議費を払わない事業所 (事業所番号)。
 * 総括表 2026-07 で おゆみ野 は 会議1件数・会議(時間) の記録がある 3 名とも 会議費 0 円だった。
 */
export const MEETING_FEE_UNPAID_OFFICES_KEY = "meeting_fee_unpaid_offices";

export async function getMeetingFeeUnpaidOffices(supabase: SupabaseClient): Promise<{ offices: Set<string>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", MEETING_FEE_UNPAID_OFFICES_KEY).maybeSingle();
  if (error) return { offices: new Set(), error: error.message };
  return { offices: new Set(((data?.value as { offices?: string[] } | null)?.offices) ?? []), error: null };
}

/**
 * 会議費で件数を数える事業所書式の項目 (2026-09-18)。{ "<事業所番号>": ["会議2", "会議3"] }。無い事業所は「会議1」。
 * おゆみ野の総括表「研修」列 = 研修費 + 会議費 = (会議2件数 + 会議3件数) × 1,150 + 会議時間 × 1,150 (2026-07 25 人中 23 人一致)
 */
export const MEETING_COUNT_ITEMS_KEY = "meeting_count_items";
export async function getMeetingCountItems(supabase: SupabaseClient): Promise<{ items: Record<string, string[]>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", MEETING_COUNT_ITEMS_KEY).maybeSingle();
  if (error) return { items: {}, error: error.message };
  return { items: ((data?.value as Record<string, string[]> | null) ?? {}), error: null };
}

/**
 * 訪問介護の出勤簿を「画面入力」(kaigo-app の出勤簿) から読む事業所 (事業所番号)。
 * 入っていない事業所は今までどおり Excel 出勤簿の CSV 取込 (payroll_attendance_records) を読む。
 * 移行中に事業所ごとに切り替えるため (2026-09-18)。
 */
export const VISIT_ATTENDANCE_SCREEN_OFFICES_KEY = "visit_attendance_screen_offices";

export async function getVisitAttendanceScreenOffices(supabase: SupabaseClient): Promise<{ offices: Set<string>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", VISIT_ATTENDANCE_SCREEN_OFFICES_KEY).maybeSingle();
  if (error) return { offices: new Set(), error: error.message };
  return { offices: new Set(((data?.value as { offices?: string[] } | null)?.offices) ?? []), error: null };
}

/** 通勤km・出張km の確認ライン (事業所番号 → km/日)。km-anomaly.ts */
export const KM_ANOMALY_LINES_KEY = "km_anomaly_lines";

export async function getKmAnomalyLines(supabase: SupabaseClient): Promise<{ lines: Record<string, { commute_per_day: number; trip_per_day: number }>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", KM_ANOMALY_LINES_KEY).maybeSingle();
  if (error) return { lines: {}, error: error.message };
  return { lines: ((data?.value as { offices?: Record<string, { commute_per_day: number; trip_per_day: number }> } | null)?.offices) ?? {}, error: null };
}

/**
 * 社員の介護超過で「0.75 掛け対象サービスの時間 × 0.25」を引く事業所 (事業所番号)。Hana 系だけ。
 * それ以外は 訪問時間 (同行込み) ＋ 研修時間 をそのまま使う (総括表 2026-03〜07 で確認、2026-09-18)。
 */
export const CARE_075_OFFICES_KEY = "care_075_offices";

export async function getCare075Offices(supabase: SupabaseClient): Promise<{ offices: Set<string>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", CARE_075_OFFICES_KEY).maybeSingle();
  if (error) return { offices: new Set(), error: error.message };
  return { offices: new Set(((data?.value as { offices?: string[] } | null)?.offices) ?? []), error: null };
}

/**
 * 重度訪問の短時間の時給 (2026-09-18)。{ "<事業所番号>": { "<区分名>": 短時間の時給 } }
 * 1 回の訪問が 1.5 時間以下なら この時給、それより長ければ 区分の時給 (payroll_category_hourly_rates) を 訪問全体に掛ける。
 * 根拠: 旧システムの確認用ブック (01_実績データ確認用.xlsm 202608) の 訪問ごとのシステム単価。
 *   おゆみ野・中央 重度7.5% 1.5h以下 1,700 / 2h以上 1,650、重度15% 1,850 / 1,800。やわた 重度 1,550 / 1,500。
 *   2026-07 の総括表で おゆみ野 3/10 → 10/10・やわた 1/3 → 3/3 人一致 (五井は合わないので入れない)
 */
/**
 * 総合事業 (サービスコード A…) で 生活援助 に結び付いている訪問の時給 (2026-09-18)。{ "<事業所番号>": 時給 }
 * 多くの事業所は生活援助と同じ時給だが、船橋だけ 1,400 円 (生活援助 1,750 円)。
 * 根拠: 旧システムの確認用ブック 202608「総合事業身なし」のシステム単価。2026-07 の総括表で 船橋の小計 4 → 17 / 19 人一致
 */
export const SOUGOU_SEIKATSU_RATES_KEY = "sougou_seikatsu_rates";
export async function getSougouSeikatsuRates(supabase: SupabaseClient): Promise<{ rates: Record<string, number>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", SOUGOU_SEIKATSU_RATES_KEY).maybeSingle();
  if (error) return { rates: {}, error: error.message };
  return { rates: ((data?.value as Record<string, number> | null) ?? {}), error: null };
}

/**
 * 同行援護 (021008 同行援護(自立)) を時間によらず固定の時給で払う事業所 (2026-09-18)。{ "<事業所番号>": 時給 }
 * それ以外の事業所は 身体介護と同じ段階式 (1.5h まで 身体介護の時給、超えた分は生活援助の時給)。
 * 根拠: 旧システムの確認用ブック 202608 の同行援護のシステム単価。五井・やわた 1,750 / KT姉崎 2,100 (長さによらず一定)。
 *   2026-07 の総括表で 五井 0/2 → 2/2・KT姉崎 0/2 → 2/2 人一致
 */
export const DOUKOU_ENGO_FLAT_RATES_KEY = "doukou_engo_flat_rates";
export async function getDoukouEngoFlatRates(supabase: SupabaseClient): Promise<{ rates: Record<string, number>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", DOUKOU_ENGO_FLAT_RATES_KEY).maybeSingle();
  if (error) return { rates: {}, error: error.message };
  return { rates: ((data?.value as Record<string, number> | null) ?? {}), error: null };
}

export const JUHO_SHORT_VISIT_RATES_KEY = "juho_short_visit_rates";
export type JuhoShortVisitRates = Record<string, Record<string, number>>;
export async function getJuhoShortVisitRates(supabase: SupabaseClient): Promise<{ rates: JuhoShortVisitRates; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", JUHO_SHORT_VISIT_RATES_KEY).maybeSingle();
  if (error) return { rates: {}, error: error.message };
  return { rates: ((data?.value as JuhoShortVisitRates | null) ?? {}), error: null };
}

export const JISSEKI_SOURCE_MODE_KEY = "jisseki_source_mode";

export async function getJissekiSourceMode(
  supabase: SupabaseClient,
): Promise<JissekiSourceMode> {
  const { data, error } = await supabase
    .from("payroll_app_settings")
    .select("value")
    .eq("key", JISSEKI_SOURCE_MODE_KEY)
    .maybeSingle();
  if (error) {
    // migration 未適用 (テーブル無し) でもアプリを壊さず CSV モードで動かす
    console.warn("[app-settings] jisseki_source_mode 取得失敗:", error.message);
    return "csv";
  }
  const mode = (data?.value as { mode?: string } | null)?.mode;
  return mode === "kaigo" ? "kaigo" : "csv";
}

/** 成功時 null、失敗時 error message を返す */
export async function setJissekiSourceMode(
  supabase: SupabaseClient,
  mode: JissekiSourceMode,
): Promise<string | null> {
  const { error } = await supabase.from("payroll_app_settings").upsert({
    key: JISSEKI_SOURCE_MODE_KEY,
    value: { mode },
    updated_at: new Date().toISOString(),
  });
  return error ? error.message : null;
}

/**
 * 固定残業代を超えた残業代を払う提責 (2026-09-19)。{ "<事業所番号>": ["<社員番号>", ...] }
 * 提責は原則 超過分を払わない (総括表「提責・事務」= 3 の 96 名) が、区分 1 の人は 超過分を払う
 * (大網 髙橋久江 2026-07: 残業代 69,686 − 固定 50,000 = 19,686 / 八千代 田中恵 2026-05: 298)。
 */
export const OVERTIME_EXCESS_PAID_KEY = "overtime_excess_paid_employees";
export async function getOvertimeExcessPaidEmployees(supabase: SupabaseClient): Promise<{ keys: Set<string>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", OVERTIME_EXCESS_PAID_KEY).maybeSingle();
  if (error) return { keys: new Set(), error: error.message };
  const v = (data?.value as Record<string, string[]> | null) ?? {};
  return { keys: new Set(Object.entries(v).flatMap(([off, nums]) => nums.map((n) => `${off}|${String(n).replace(/^0+/, "")}`))), error: null };
}

/**
 * 社員の残業代から「支払う介護超過手当の全額 (入浴時間・HRD 込み) + 深夜手当」を差し引く事業所 (2026-09-19)。{ offices: ["<事業所番号>"] }
 * 既定は (生の訪問時間 − 120h) × 単価 + 深夜手当。リンクス茂原の総括表は 差し引き = 介護超過の支払額 と同額
 * (寺内 2026-06: 生 76,042 + HRD 1h 2,500 = 78,542 / HO 2026-07: 入浴 2,310分 + HRD 込みで 107,292)。
 */
export const OVERTIME_OFFSET_FULL_CARE_OFFICES_KEY = "overtime_offset_full_care_offices";
export async function getOvertimeOffsetFullCareOffices(supabase: SupabaseClient): Promise<{ offices: Set<string>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", OVERTIME_OFFSET_FULL_CARE_OFFICES_KEY).maybeSingle();
  if (error) return { offices: new Set(), error: error.message };
  return { offices: new Set(((data?.value as { offices?: string[] } | null)?.offices) ?? []), error: null };
}
