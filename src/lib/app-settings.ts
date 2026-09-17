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

export async function getWeekendHolidayRates(supabase: SupabaseClient): Promise<{ rates: Record<string, number>; error: string | null }> {
  const { data, error } = await supabase.from("payroll_app_settings").select("value").eq("key", WEEKEND_HOLIDAY_RATES_KEY).maybeSingle();
  if (error) return { rates: {}, error: error.message };
  return { rates: ((data?.value as { rates?: Record<string, number> } | null)?.rates) ?? {}, error: null };
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
