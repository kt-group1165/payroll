"use client";

import { Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { isValidLoginId, loginIdToSyntheticEmail } from "@/lib/login_id";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";
  const supabase = createClient();

  function resolveEmail(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.includes("@")) return trimmed; // 実 email
    if (isValidLoginId(trimmed)) return loginIdToSyntheticEmail(trimmed);
    return null;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = resolveEmail(identifier);
    if (!email) {
      toast.error("ログイン ID または メールアドレスの形式が正しくありません");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      toast.error("ログインに失敗しました: " + error.message);
    } else {
      router.push(nextPath);
      router.refresh();
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-gradient-to-br from-emerald-50 to-emerald-100">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-emerald-700">給与計算システム</h1>
          <p className="mt-2 text-sm text-gray-500">ログインしてください</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              ログイン ID または メールアドレス
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoComplete="username"
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              placeholder="staff001 または name@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">パスワード</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              placeholder="パスワード"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? "ログイン中..." : "ログイン"}
          </button>
        </form>
      </div>
    </div>
  );
}
