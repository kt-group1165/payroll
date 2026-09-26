-- payroll_legacy_contract を effective_from 方式で履歴化する (2026-09-26)
--
-- 【なぜ】
-- 給与A が2026-09-26 に payroll_* 30 表の棚卸しで最優先と判定した表。
--   ① マスタ (1 職員 = 1 行。本人給・職能給・役職手当・固定残業代など 30 列)
--   ② 取込 script (import_legacy_contract.mjs) が
--      on_conflict=office_number,employee_number の upsert で **単一行を上書き**する
--   ③ payroll/page.tsx が **選択した月に関わらずこの 1 行を毎回参照**して計算に使う
--   → 再取込みで本人給などが変わると 過去月の計算結果まで一緒にズレる。
--   テーブル自身のコメントが「★ 履歴ではなく今の設定」と明記しており、
--   設計時点で過去分への影響が意識されていなかった。
--
-- 【今の利用範囲(2026-09-26 時点)】 ⚠ 過大に見積もらないための実測
--   コードから読んでいるのは src/app/payroll/page.tsx の 1 箇所だけで、
--   列も childcare_limit / childcare_rate_pct / childcare_method の 3 列のみ
--   (本人給・職能給・役職手当・固定残業代などは **まだどこからも読まれていない**)。
--   → 履歴化そのものは表全体に効かせるが、「今すぐ壊れる」のはこの 3 列の育児手当計算だけ。
--
-- 【取込の履歴 (実測)】
--   全 1,293 行の created_at が 2026-09-20T21:04:36〜37 UTC の単一クラスタに収まっており、
--   1回のバッチ投入 (200件ずつ7回 POST) のみで、**再取込は一度も発生していない**。
--   → 現時点の実害は 0。次に取り込むと 初めて過去月が静かに変わる状態。
--   ⚠ この表には updated_at 列が無いため、再取込が起きても後から検出できない。
--     今回 updated_at を追加するのは この「検出できない」問題への対応も兼ねる。
--
-- 【方式】既存の payroll_offices / payroll_overtime_settings と同じ effective_from 方式。
--   ・append-only。改定は UPDATE せず 新しい effective_from の行を INSERT する
--   ・対象月で有効な行 = effective_from <= 対象月の 1 日 の中で最新
--     (src/lib/payroll/salary-history.ts の getActiveSalary と同じ規約)
--   ・★ 過去の行を消さない
--
-- 【effective_from の初期値は 1970-01-01 (取込日 2026-09-20 ではない)】
--   給与A は当初「取込日 (created_at) を使う」と提案したが、payroll_offices /
--   payroll_overtime_settings が同日に 1970-01-01 を初期値にしたのを見て訂正する。
--   理由: この契約情報は 2026-09-20 に初めて発生したものではなく、それ以前から
--   有効だった条件を **デジタルに取り込んだ日**が 2026-09-20 なだけ。取込日を
--   effective_from にすると「この条件は 2026-09-20 から」と誤った情報になり、
--   2026-09-20 より前の月を計算すると **この履歴行が一件も無い**ことになって
--   育児手当が消える (0 円になる)。1970-01-01 にしておけば「いつからか分からないが
--   ずっとこの内容だった」という今までどおりの挙動を守れる。
--
-- ⚠ 一意制約の名前は `DROP CONSTRAINT IF EXISTS` を両方の候補名に当てる形にしてあるので、
--   実際の名前がどちらでも通る。
--   ★ 当初「service_role で重複 INSERT させて確認した」と書いてあったが、
--     **本番 DB にわざとエラーを起こして制約名を調べるのは禁止**。名前を知りたいときは
--     SQL Editor で `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'public.payroll_legacy_contract'::regclass;` を読む。
--
-- ⚠ RLS は既に有効で **SELECT のみ**のポリシーが入っている。★ ここを広げない。
--   書き込みは import script が service_role で行うので authenticated に書き込みは要らない。
--   「他の履歴表と揃える」ために権限を広げるのは、揃えるためだけに穴を開けることになる。
--   ★ 揃えるなら 狭いほうへ揃える。

BEGIN;

ALTER TABLE public.payroll_legacy_contract
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT DATE '1970-01-01';
ALTER TABLE public.payroll_legacy_contract
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- ★ 既存の 1,293 行は 一度も UPDATE されていないので updated_at を created_at に揃える。
--   揃えないと「列を足した時刻」が入り、★ 全行が「取込より後に更新された」ように見えて
--   check:calc-freshness などが 全件を「古い」と誤判定する。
UPDATE public.payroll_legacy_contract SET updated_at = created_at WHERE updated_at <> created_at;

COMMENT ON COLUMN public.payroll_legacy_contract.effective_from IS
  'この契約情報がいつから有効か。改定のたびに (UPDATE せず) 新しい行を足す。初期値は 1970-01-01 (改定履歴が手元に無いため)';
COMMENT ON COLUMN public.payroll_legacy_contract.updated_at IS
  '2026-09-26 追加。この表は append-only 運用なので基本 created_at と同じになるはずだが、
   万一 UPDATE された場合に気づけるようにするための列';

-- 職員ごとに 1 行だけだった一意制約を外し、(office_number, employee_number, effective_from) に広げる。
-- ⚠ 実際の名前がどちらでも通るよう、候補名の両方に DROP IF EXISTS を当てている。
ALTER TABLE public.payroll_legacy_contract
  DROP CONSTRAINT IF EXISTS payroll_legacy_contract_office_number_employee_number_key;
ALTER TABLE public.payroll_legacy_contract
  DROP CONSTRAINT IF EXISTS payroll_legacy_contract_office_emp_eff_uniq;
ALTER TABLE public.payroll_legacy_contract
  ADD CONSTRAINT payroll_legacy_contract_office_emp_eff_uniq
  UNIQUE (office_number, employee_number, effective_from);

CREATE INDEX IF NOT EXISTS payroll_legacy_contract_emp_eff_idx
  ON public.payroll_legacy_contract (office_number, employee_number, effective_from DESC);

-- ★ RLS は触らない。既にある SELECT のみのポリシーのままにする。
--   書き込みは import script が service_role で行うので authenticated の書き込みは要らない。
--   (当初ここに FOR ALL TO authenticated に広げる CREATE POLICY があったが、
--    「他の履歴表と揃える」ためだけに権限を広げるのは穴を開けることになるので消した。2026-09-26)

COMMIT;

-- 検算用 (上の COMMIT 後に別途流す)
--   ⚠ 今回は既存行に列を 2 本足しただけ (新しい表へのコピーではない) なので、
--     「元の値と食い違っていないか」ではなく「行が増減していないか・重複していないか」を確認する。
--   SELECT count(*) AS 行数 FROM payroll_legacy_contract;                          -- 期待 1293 (移行前と同じ)
--   SELECT effective_from, count(*) FROM payroll_legacy_contract GROUP BY 1;       -- 期待 1970-01-01 が 1293
--   SELECT office_number, employee_number, count(*) FROM payroll_legacy_contract
--   GROUP BY 1, 2 HAVING count(*) > 1;                                              -- 期待 0行 (重複が無いこと)
--   SELECT count(*) FROM payroll_legacy_contract WHERE updated_at IS DISTINCT FROM created_at;
--                                                                                    -- 期待 0 (append-only なので今はまだ誰も UPDATE していない)

-- 次にやること (この SQL だけでは何も変わらない):
--   1. src/app/payroll/page.tsx の contractOf 読み込み (935-940行目) を
--      「対象月の 1 日 <= effective_from の最新行」を選ぶ形に変える
--      (getActiveSalary と同じ規約。office_number 単位で絞ってから 1 pass でよい)
--   2. import_legacy_contract.mjs を「同じ effective_from (=1970-01-01 のままなら通常の
--      再取込) なら上書き、契約改定に伴う再取込なら新しい effective_from で INSERT」に変える。
--      具体案は import_legacy_contract.mjs 側の変更案を参照 (給与A作成、別途提示)。
