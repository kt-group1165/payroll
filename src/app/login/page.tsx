"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { isValidLoginId } from "@/lib/login_id";
import { ensureDeviceId, detectDeviceLabel } from "@/lib/device_id";

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
  const [info, setInfo] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";

  function identifierLooksValid(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes("@")) return true;
    return isValidLoginId(trimmed);
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifierLooksValid(identifier)) {
      toast.error("ログイン ID または メールアドレスの形式が正しくありません");
      return;
    }
    setLoading(true);
    setInfo(null);
    try {
      // Phase 11c trust model: device_id を /api/login に送る
      const deviceId = ensureDeviceId();
      const deviceLabel = detectDeviceLabel();
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim(),
          password,
          device_id: deviceId,
          device_label: deviceLabel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: "approval_required" | "device_revoked";
        message?: string;
      };

      if (res.ok && data.ok) {
        router.push(nextPath);
        router.refresh();
        return;
      }
      // 202: 新端末 / pending → 承認待ち
      if (data.status === "approval_required") {
        setInfo(data.message ?? "新しい端末からのログインです。管理者の承認をお待ちください。");
        return;
      }
      // 403: revoked 端末
      if (data.status === "device_revoked") {
        toast.error(data.message ?? "この端末は無効化されています。管理者に連絡してください。");
        return;
      }
      // 401: 認証失敗
      if (res.status === 401) {
        toast.error("ログイン ID（またはメール）かパスワードが正しくありません");
        return;
      }
      // その他のエラー
      toast.error(data.message ?? "ログインに失敗しました");
    } catch {
      toast.error("ログインに失敗しました");
    } finally {
      setLoading(false);
    }
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
          {info && (
            <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {info}
            </div>
          )}
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
