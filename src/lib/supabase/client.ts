import { createBrowserClient } from "@supabase/ssr";
import { createBatchCachingFetch } from "./batch-cache-fetch";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      // まとめて再計算の間だけ 旧システムの職員表の読み込みを使い回す (既定は素通し)。batch-cache-fetch.ts
      { global: { fetch: createBatchCachingFetch((...a) => fetch(...a)) } },
    );
  }
  return client;
}
