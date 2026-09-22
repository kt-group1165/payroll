import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Phase 3-3a: payroll-app に Supabase Auth による route gate を導入。
// /login と _next 静的アセット以外は authenticated 必須。
// useSearchParams と組合せた /login?next=<元 URL> redirect で、
// ログイン後に元の page に戻す。

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getUser() は毎回 Supabase Auth に問い合わせるので、左メニューの移動 (と Link の先読み) のたびに往復が 1 回増えていた。
  // getClaims() は JWT の署名をこの場で検証する (このプロジェクトの鍵は ES256 = 公開鍵で検証できる。鍵は cache される)。
  // 期限切れなら内部で refresh するので ログインの扱いは変わらない (2026-09-22「メニューの遷移をサクサクに」)
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims?.sub ? claimsData.claims : null;

  const { pathname } = request.nextUrl;

  // /login と /api/login は未認証で通す (login flow の起点)
  if (!user && !pathname.startsWith("/login") && pathname !== "/api/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    if (pathname !== "/") url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (user && pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
