import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || url === "your-supabase-url") {
      throw new Error(
        "Supabaseの設定が必要です。.env.localにNEXT_PUBLIC_SUPABASE_URLとNEXT_PUBLIC_SUPABASE_ANON_KEYを設定してください。"
      );
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// 後方互換のためのエイリアス（使用箇所で直接getSupabase()を呼ぶほうが望ましい）
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return Reflect.get(getSupabase(), prop);
  },
});
