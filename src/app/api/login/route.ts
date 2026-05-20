import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidLoginId, loginIdToSyntheticEmail } from "@/lib/login_id";
import { isMasterUser } from "@/lib/master_user";

// POST /api/login
//
// Phase 11c trust model 移植 (payroll-app、trust-only 版):
//   - calendar-app の /api/login をベースに、passkey 排他 check (hasPasskey
//     ブロック) を削除した版。payroll-app には passkey 認証 endpoint が
//     無いため、含めると user が lockout される。
//   - trust check ロジック (initial pending insert + revoked/pending block
//     + approved last_seen_at update) は calendar-app と同じく適用。
//   - master user (env MASTER_USER_EMAILS) は trust check を bypass。

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { identifier, password, device_id, device_label } = (body ?? {}) as {
    identifier?: unknown;
    password?: unknown;
    device_id?: unknown;
    device_label?: unknown;
  };

  if (typeof identifier !== "string" || identifier.trim().length === 0) {
    return NextResponse.json({ error: "identifier_required" }, { status: 400 });
  }
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "password_required" }, { status: 400 });
  }
  // Phase 11c-2: device_id 必須化 (= trust check のため)
  if (typeof device_id !== "string" || device_id.length === 0) {
    return NextResponse.json(
      { error: "device_id_missing", message: "デバイス識別子が取得できませんでした。Cookie 設定を有効にしてください。" },
      { status: 400 }
    );
  }

  // identifier → email 解決
  const trimmed = identifier.trim();
  let email: string | null = null;
  if (trimmed.includes("@")) {
    email = trimmed;
  } else if (isValidLoginId(trimmed)) {
    email = loginIdToSyntheticEmail(trimmed);
  }
  if (!email) {
    return NextResponse.json({ error: "credentials_invalid" }, { status: 401 });
  }

  // user 解決 (service_role で auth.users を listUsers)
  const admin = createAdminClient();
  const { data: usersList, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  const targetUser = (usersList?.users ?? []).find((u) => u.email === email);

  // 認証実行 (server client で cookies に session を書く)
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) {
    return NextResponse.json({ error: "credentials_invalid" }, { status: 401 });
  }

  // Phase 11c-2: trusted_devices check (PW ログイン経路にも適用)
  //   PW 認証成功した user 自身を改めて引いて trust 判定。
  //   新端末 (未登録 or pending) なら session を即 signOut() して 202 返却。
  //
  // master user (env MASTER_USER_EMAILS で指定) は trust check を bypass。
  // 開発者本人が端末ロックでログインできなくなる事態を回避する。
  if (targetUser && !isMasterUser(targetUser.email)) {
    const ua = request.headers.get("user-agent") ?? null;
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      null;
    const { data: trustRow } = await admin
      .from("trusted_devices")
      .select("status")
      .eq("user_id", targetUser.id)
      .eq("device_id", device_id)
      .maybeSingle();

    const gateUntrusted = async (status: "approval_required" | "device_revoked", httpStatus: number, message: string) => {
      // 直前に設定された session cookie を破棄
      await supabase.auth.signOut();
      return NextResponse.json(
        { status, message },
        { status: httpStatus }
      );
    };

    if (!trustRow) {
      // 初見端末 → pending 行作成
      await admin.from("trusted_devices").insert({
        user_id: targetUser.id,
        device_id: device_id,
        device_label: typeof device_label === "string" ? device_label : null,
        status: "pending",
        first_seen_ua: ua,
        first_seen_ip: ip,
      });
      return gateUntrusted(
        "approval_required",
        202,
        "新しい端末からのログインです。管理者の承認をお待ちください。承認されたら再度お試しください。"
      );
    }
    if (trustRow.status === "revoked") {
      return gateUntrusted(
        "device_revoked",
        403,
        "この端末は管理者により無効化されています。管理者に連絡してください。"
      );
    }
    if (trustRow.status === "pending") {
      // 既に pending: last_seen_at だけ更新
      await admin
        .from("trusted_devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("user_id", targetUser.id)
        .eq("device_id", device_id);
      return gateUntrusted(
        "approval_required",
        202,
        "管理者の承認待ちです。承認されたら再度お試しください。"
      );
    }
    // status === 'approved' → last_seen_at 更新 + session 維持
    await admin
      .from("trusted_devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", targetUser.id)
      .eq("device_id", device_id);
  }

  return NextResponse.json({ ok: true });
}
