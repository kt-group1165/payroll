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
