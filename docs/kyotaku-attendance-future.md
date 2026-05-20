# 居宅介護支援 出勤簿 将来仕様メモ

## ② ケアマネ別 URL 発行式 出勤簿入力 (未実装)

### 目的
各ケアマネが個別に URL を貰い、そこから自分の出勤簿を入力する。
現状は payroll-app 内 (domen / 管理者のみアクセス) の `/kyotaku-attendance` でしか入力できない。
これだと domen がデータ集約担当になってボトルネック。

### 仕様 (草案)

#### URL 発行
- 各ケアマネに 1 つの専用 URL を発行
- 例: `/kyotaku-attendance/c/<token>`
- token は 32 byte base64url、`payroll_kyotaku_input_tokens` table に保存
- 失効期限なし (or 1 年など。要決定)
- 1 URL 1 ケアマネに固定 (`employee_id` 紐付け)

#### 役割別の挙動
- **member (= 一般ケアマネ)**:
  - URL を踏むと自分の出勤簿のみ閲覧/編集可
  - 月切替・件数入力・加算入力 が可能
- **管理者 (= 事業所責任者)**:
  - URL を踏むと **プルダウンで事業所全員のスタッフを切替可**
  - 自分以外のケアマネ分も閲覧/修正可能
  - 「管理者」フラグは `payroll_employees.role` or 新規 column で判定 (要設計)

#### 認証 / 権限
- token 自体が認証になる (= URL を知っている人 = 本人 とみなす)
- ただし token は URL に含まれるため、SMS / メールで送信時の漏洩リスクあり
- 対策案:
  - (a) token + 4 桁 PIN を組み合わせ (PIN は本人に別途伝える)
  - (b) token 単独 + LINE/SMS でだけ送信 (= 経路認証)
  - (c) Supabase Auth ベースの login_id + PW (= /admin/staff invitation 経由) に統合 → ケアマネが個別 login → 自分のページに飛ぶ
- 最も筋が良いのは (c)。calendar-app と同じ機構なら一貫性あり、`/admin/staff` で発行 → user 自身が PW 設定 → `/kyotaku-attendance` でセッションから自動 employee_id 解決

#### 推奨実装方針 (= (c) 案)
1. payroll-app に Supabase Auth + middleware を導入 (calendar-app と同じ Phase 3-3a の機構)
2. `auth.users` → `payroll_employees.auth_user_id` link (calendar-app の `members.auth_user_id` と同等)
3. `/kyotaku-attendance` を一般 user 向け mode に分岐:
   - URL に `office=` / `employee=` パラメタなし → 自分の出勤簿
   - パラメタあり + 管理者権限 → そのスタッフの出勤簿 (現行 UI と互換)
4. `/admin/staff` 相当の招待 UI を payroll-app にも実装 (or calendar-app と統合)

### 関連 issue / 既存実装
- 居宅介護支援 出勤簿: `apps/payroll-app/src/components/payroll/kyotaku-attendance-content.tsx`
- 月単位件数/加算 (本セッションで実装): `payroll_kyotaku_attendance_monthly` + `_kasan` table
- calendar-app の Supabase Auth + invitation flow: `apps/calendar-app/app/admin/staff/page.tsx` + `app/api/admin/invite-staff/route.ts`

### 工数見積
中規模 (Auth + middleware 移植 + UI 改修): 約 3-5 営業日相当
