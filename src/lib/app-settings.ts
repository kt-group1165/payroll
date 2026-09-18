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
