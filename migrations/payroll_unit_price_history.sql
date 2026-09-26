-- 事業所の単価・残業設定を effective_from 方式で履歴化する (2026-09-26 user 承認)
--
-- 【なぜ】
-- 金額・率・時間を持つ payroll_* の表 30 件を全数で洗ったところ、**18 件が時点を持っていなかった**
-- (PostgREST の OpenAPI を正とした。コード grep は必ず漏れるので使っていない)。
-- 時点が無い表は **上書きすると過去の月が静かに変わる**。落ちないので気づけない。
--
--   payroll_offices             出張単価・通勤単価・処遇改善額・キャンセル単価・会議単価・通信費 ほか
--                               → ★ 毎月の全員に効く。★ user 曰く「年 1 回は変わる」
--   payroll_overtime_settings   所定時間・残業の基礎に何を含めるか (9 項目)
--                               → ★ 変えると 過去の残業単価が全部変わる
--
-- ⚠ 2026-09-26 に「6 ヶ月測ったが単価は一定だったので月次化は不要」と一度結論したが **誤り**。
--   測定窓が 2026-03〜08 の 6 ヶ月しかなく、年 1 回の改定を見られるはずがなかった。
--   「一致件数 ≠ 検証」と同じ型。★ 窓の長さを見ずに「変わらない」と言わないこと。
--
-- 【方式】既に payroll_salary_settings / payroll_kyotaku_settings / payroll_kyotaku_salary /
--   payroll_category_hourly_rates で動いている effective_from 方式に揃える。
--     ・append-only。編集は UPDATE せず 新しい effective_from の行を INSERT する
--     ・対象月で有効な行 = effective_from <= 対象月の 1 日 の中で最新
--       (src/lib/payroll/salary-history.ts の getActiveSalary と同じ規約)
--     ・★ 過去の行を消さない。消すとその月が計算できなくなる
--     ・初期値の effective_from は '1970-01-01' (payroll_salary_settings と同じ慣習。746 行がこれ)
--
-- ⚠ 単価の改定が 全事業所いっせいか 事業所ごとにバラバラかは **まだ分かっていない** (調査中)。
--   effective_from 方式なら **どちらでも表現できる** (いっせいなら同じ日付の行が 22 本、
--   バラバラなら日付が散るだけ) ので、判明を待たずに移行してよい。
--
-- ⚠ payroll_kyotaku_regional_rates も時点を持たないが **0 行**なので今回は触らない。
--   使い始める前に同じ形にすること。
--
-- ⚠ payroll_offices の旧列は **この migration では消さない**。
--   コード側を履歴表に切り替えてから、別の migration で DROP する。
--   (二重経路を長く残すと どちらが正か分からなくなるので、切替後すぐに消すこと)

BEGIN;

-- ── ① 事業所の単価 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_office_unit_prices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id       uuid NOT NULL REFERENCES public.payroll_offices(id) ON DELETE CASCADE,
  effective_from  date NOT NULL,
  travel_unit_price        numeric,
  commute_unit_price       numeric,
  treatment_subsidy_amount numeric,
  cancel_unit_price        numeric,
  travel_allowance_rate    numeric,
  communication_fee_amount numeric,
  meeting_unit_price       numeric,
  distance_adjustment_rate numeric,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_office_unit_prices_uniq UNIQUE (office_id, effective_from)
);

COMMENT ON TABLE public.payroll_office_unit_prices IS
  '事業所ごとの単価の履歴 (append-only)。対象月で有効な行 = effective_from <= 対象月の1日 の最新。★過去の行を消さないこと';
COMMENT ON COLUMN public.payroll_office_unit_prices.effective_from IS
  'この値がいつから有効か。改定のたびに行を足す (UPDATE しない)。初期値は 1970-01-01';

CREATE INDEX IF NOT EXISTS payroll_office_unit_prices_office_idx
  ON public.payroll_office_unit_prices (office_id, effective_from DESC);

ALTER TABLE public.payroll_office_unit_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_office_unit_prices_authenticated_all ON public.payroll_office_unit_prices;
CREATE POLICY payroll_office_unit_prices_authenticated_all ON public.payroll_office_unit_prices
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 今の値を 1970-01-01 からの初期値として入れる。
-- ⚠ これで過去が救えるわけではない (改定履歴が手元に無いため)。守れるのは これ以降の改定だけ。
INSERT INTO public.payroll_office_unit_prices (
  office_id, effective_from,
  travel_unit_price, commute_unit_price, treatment_subsidy_amount, cancel_unit_price,
  travel_allowance_rate, communication_fee_amount, meeting_unit_price, distance_adjustment_rate,
  note
)
SELECT
  o.id, DATE '1970-01-01',
  o.travel_unit_price, o.commute_unit_price, o.treatment_subsidy_amount, o.cancel_unit_price,
  o.travel_allowance_rate, o.communication_fee_amount, o.meeting_unit_price, o.distance_adjustment_rate,
  '2026-09-26 payroll_offices の現在値から初期投入。改定履歴が手元に無いため 1970-01-01 起点'
FROM public.payroll_offices o
ON CONFLICT (office_id, effective_from) DO NOTHING;

-- ── ② 残業設定 ────────────────────────────────────────────────────
-- 既存表に effective_from を足し、一意制約を (job_type, effective_from) に広げる。
ALTER TABLE public.payroll_overtime_settings
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT DATE '1970-01-01';

COMMENT ON COLUMN public.payroll_overtime_settings.effective_from IS
  'この設定がいつから有効か。所定時間や「基礎に何を含めるか」を変えるときは UPDATE せず 行を足す。★変えると過去の残業単価が全部変わる';

-- job_type だけの一意制約が残っていると 履歴行を足せないので外す (名前は環境で違うため動的に)
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public'
      AND rel.relname = 'payroll_overtime_settings'
      AND con.contype IN ('u', 'p')
      AND (SELECT array_agg(att.attname ORDER BY att.attname)
           FROM unnest(con.conkey) k
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k)
          = ARRAY['job_type']
  LOOP
    EXECUTE format('ALTER TABLE public.payroll_overtime_settings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- job_type だけの一意 INDEX (制約ではない形) も外す
DO $$
DECLARE i record;
BEGIN
  FOR i IN
    SELECT c.relname AS idxname
    FROM pg_index x
    JOIN pg_class c ON c.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'public' AND t.relname = 'payroll_overtime_settings'
      AND x.indisunique AND NOT x.indisprimary
      AND (SELECT array_agg(att.attname ORDER BY att.attname)
           FROM unnest(x.indkey::int[]) k
           JOIN pg_attribute att ON att.attrelid = x.indrelid AND att.attnum = k)
          = ARRAY['job_type']
  LOOP
    EXECUTE format('DROP INDEX public.%I', i.idxname);
  END LOOP;
END $$;

ALTER TABLE public.payroll_overtime_settings
  DROP CONSTRAINT IF EXISTS payroll_overtime_settings_job_eff_uniq;
ALTER TABLE public.payroll_overtime_settings
  ADD CONSTRAINT payroll_overtime_settings_job_eff_uniq UNIQUE (job_type, effective_from);

COMMIT;

-- 確認用 (上の COMMIT 後に別途流す)
--   SELECT count(*) AS 事業所単価の行数 FROM payroll_office_unit_prices;              -- 期待 60
--   SELECT effective_from, count(*) FROM payroll_office_unit_prices GROUP BY 1;        -- 期待 1970-01-01 が 60
--   SELECT job_type, effective_from, scheduled_hours_per_month FROM payroll_overtime_settings ORDER BY 1;
--   -- 期待 7 行・全部 1970-01-01。訪問介護 168 / 他 160
--
-- 次にやること (この SQL だけでは何も変わらない):
--   1. コード側を payroll_office_unit_prices / effective_from 付き overtime_settings から読むよう変える
--   2. 切替を確認したら payroll_offices の旧単価列を DROP する別 migration を出す
--   3. 過去の改定日が判明したら 行を足す (UPDATE しない)
