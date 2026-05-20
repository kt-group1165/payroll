import { createServerClient } from "@supabase/ssr";

// service_role を使う admin クライアント。RLS をバイパスするため、
// 呼び出し側で必ず別の認証要素 (= /api/login での認証成功や trust check 等)
// を検証してから使うこと。Phase 11c trust check 用に新設。
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey,
    {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    }
  );
}
