// Phase 3-3a: Supabase Auth (cookie-based session) に切替後の compat shim。
// 既存コードが `import { supabase } from "@/lib/supabase"` で参照しているので、
// browser 用 ssr client (lib/supabase/client.ts) に delegate する。

import { createClient } from "./supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

export function getSupabase(): SupabaseClient {
  return createClient() as unknown as SupabaseClient;
}

// 後方互換: 既存の `from(...)` chain は新しい cookie-aware client にそのまま流れる
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return Reflect.get(getSupabase(), prop);
  },
});
