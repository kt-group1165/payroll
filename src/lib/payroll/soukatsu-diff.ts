// 総括表 (旧システムで実際に払った額) と 当システムの計算結果を 項目ごとに突き合わせる。
//
// 移行期だけのもの。本稼働後は総括表が無くなるので この module ごと落とす。
// 「どこがどうずれているか」と「直す必要があるか」を画面 (/verification) に出すために使う。
//
// ⚠ 分類は **確かめた理由があるものだけ「許容」にする**。理由が分からないものは
//   「要確認」に残す。許容に倒すと 本物のバグが見えなくなる。

/** 差の扱い */
export type DiffVerdict =
  /** 直す必要がある。当システムか マスタか 元データの入力漏れ */
  | "要対応"
  /** 当システムのほうが正しい / 総括表側の事情。追いかけなくてよい */
  | "許容"
  /** 理由が分かっていない。調べる */
  | "要確認";

export type ItemDiff = {
  item: string;
  ours: number;
  soukatsu: number;
  diff: number;          // 総括表 − 当方
  verdict: DiffVerdict;
  reason: string;
};

/** 総括表の列名は事業所・月でぶれる。候補を順に見て 最初に見つかったものを使う */
export const SOUKATSU_ALIASES: Record<string, string[]> = {
  総支給額: ["総支給額"],
  集計項目小計: ["集計項目小計"],
  土日祝: ["土日祝"],
  勤続手当: ["勤続手当", "資格or勤続手当", "・勤続手当・資格手当"],
  処遇改善補助金手当: ["処遇改善補助金手当"],
  移動手当: ["移動手当"],
  有給休暇手当: ["有給休暇手当"],
  通信手当: ["通信手当"],
  通勤費: ["通勤費"],
  出張費: ["出張費"],
  ドタキャン: ["ドタキャン"],
  特日: ["特日", "・特日"],
  残業総額: ["残業総額"],
  育児手当: ["育児手当"],
  調整手当: ["調整手当"],
  介護: ["介護"],
  夜朝深夜: ["・夜朝・深夜"],
  // ⚠ 出勤時間は 分。pickSoukatsu (円) では読まない。verification-items.ts が soukatsuMinutes で読む。
  //   ここに残すのは hasSoukatsuColumn の「列の有無」に使うため (消すと 検証ページから出勤時間の行が消える)
  出勤時間: ["出勤時間"],
  本人給: ["本人給"],
  事務時給: ["事務時給"],
  誤差: ["誤差"],
  初任者研修費: ["初任者研修費"],
  // ★ 提責_社員シートの列。② は 負の数で持つ (当方は 引く額を正の数で持つので 符号を合わせる)
  欠勤控除: ["欠勤控除"],
  // ★ パートの ② 総支給の式に入る列 (2026-10-01 実測)。★ 当方は 研修+会議費 を当てる
  その他手当: ["その他手当"],
  初任者研修調整費: ["初任者研修調整費"],
  // ★ 「特日2」は soukatsuAdjustmentParts (= 調整手当の内訳) 専用。★ 提責_社員シートの列名だけを見る。
  //   ⚠ ここに "特日" を足してはいけない。★ パートシートの「特日」列を拾ってしまい、
  //   ★ 調整手当 (介護+夜朝+特日−誤差) の内訳に パートの特日が紛れ込む (2026-10-01)。
  //   ★ パートに 調整手当(内訳計) を当てないほうで直した (verification-items.ts)。
  特日2: ["・特日"],
  // 社員 (提責・社員シート) の固定給まわり。2026-09-24 に 202607 の実データで 値が入っている列を数えて足した
  職能給: ["職能給"],
  役職手当: ["役職手当"],
  資格手当: ["資格手当"],
  処遇改善手当: ["処遇改善手当"],
  特別処遇改善手当: ["特別処遇改善手当", "特定処遇改善手当"],
  固定残業代: ["固定残業代"],
};

/**
 * 総括表の 1 行から 項目の値を取り出す (別名を吸収し 数値にする)。
 * ★ これは **円** を読む関数 (parseFloat + カンマ除去)。時間は soukatsuMinutes (soukatsu-time.ts) を使う。
 *   parseFloat は "35:00" を 35、"174..00" を 174 と黙って読む。
 * ★ ourItems の item を 変数で渡す箇所がある (verification-items.ts)。時間の項目 (MINUTE_ITEMS) は 呼び側で分けること。
 *   literal の grep (pickSoukatsu(…, "出勤時間")) では見つからない (2026-09-27 に 1 度見落とした)
 */
export function pickSoukatsu(row: Record<string, unknown>, key: string): number {
  for (const name of SOUKATSU_ALIASES[key] ?? [key]) {
    const v = row[name];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/** 総括表に その項目の列が そもそも無いか (0 と 列なし を区別する) */
export function hasSoukatsuColumn(row: Record<string, unknown>, key: string): boolean {
  return (SOUKATSU_ALIASES[key] ?? [key]).some((name) => name in row);
}

/**
 * 項目ごとの「なぜずれるか」。理由が確かめられているものだけ入れる。
 * `when` が true を返したときだけ その判定を使う。上から順に見る。
 */
type Rule = {
  item: string;
  verdict: DiffVerdict;
  reason: string;
  when?: (d: { ours: number; soukatsu: number; diff: number; ctx: DiffContext }) => boolean;
};

export type DiffContext = {
  /** その職員の役職 (社員 / 提責 / 事務員 / パート) */
  roleType: string;
  /**
   * 事務員として扱う人か (payroll_employees.is_office_worker)。
   * ⚠ 役職が「パート」でも 事務員の人がいる (五井 根本カオリ・市原ムツミ 片岡久美子 など 時給の事務員 17 名)。
   *   roleType だけで見ると この人たちの穴が 判定から漏れる (2026-09-24)
   */
  isOfficeWorker?: boolean;
  /** 出勤簿の「勤務時間の欄」と「終了−開始−休憩」が食い違う分 (分)。0 なら食い違い無し */
  attendanceGapMinutes: number;
  /** 当システムに出勤簿が 1 件も無いか */
  noAttendance: boolean;
  /** 単価が引けず 0 円になった訪問があるか */
  hasRateGap: boolean;
  /** 事業所番号 */
  officeNumber: string;
  /**
   * その人月の総括表が 介護超過・夜朝・特日 を「調整手当」に畳み込んでいるか。
   * true のとき 個別項目の差は 参考表示にして、突合は「調整手当(内訳計)」で行う (2026-09-24)。
   */
  adjustmentFolded?: boolean;
  /**
   * その事業所・月の 事業所書式が 1 行も読めていないか。
   * 2026-09-24 に 合流処理の自己参照バグで 書式が丸ごと消え、出張費・会議費が全社 0 円になった。
   * 1 人ずつ「書式の入力漏れ」と読むと 事故に気づけないので 別の理由として出す。
   */
  officeFormEmpty: boolean;
  /**
   * ② の「誤差」列の値。★ ② が自分で記録している「システム総支給額 − 実際に払う額」。
   * ★ 調整手当(内訳計) の ② 側は この 誤差 を引いた値なので (soukatsuAdjustmentParts)、
   *   ★ 当方の 介護超過+夜朝+特日 と比べると **誤差ぶんだけ必ずずれる**。
   *   ★ 誤差は 当方の 3 部品のどれでもないので、差が 誤差と同額なら 追いかけなくてよい。
   * 2026-10-01 実測: 調整手当(内訳計) の 要確認 709 人月のうち **408 (全部 時給者)** がこれ。
   */
  soukatsuGosa?: number;
  /**
   * その人月を指すキー (processing_month と 職員番号)。★ KNOWN_DIFFS の照合にだけ使う。
   * ★ 渡さなくても動く (そのとき KNOWN_DIFFS は効かない)。
   */
  processingMonth?: string;
  employeeNumber?: string;
};

/**
 * ★ **1 件ずつ user が「許容」と判断した差** (2026-10-01 新設)。
 *
 * ⚠ 規則で説明できる差は RULES に書く。ここは **規則にならない 1 件もの**だけ。
 * ⚠ 足すときは **必ず user の判断を得てから**。★ 勝手に増やすと「合わせただけ」になる。
 * ⚠ 消えたときに気付けるよう、★ 該当が 0 件になったら check:verification-verdicts の件数が動く。
 *
 * キー: `事業所番号|処理月|職員番号|項目`
 */
export const KNOWN_DIFFS: Readonly<Record<string, string>> = {
  // 袖ヶ浦ムツミ 池田麻美 202605。② 9,091 / 当方 400。
  //   ★ 同じ人の 202606〜08 は 実績(分)÷60×単価10 で ② と 1 円まで一致する。202605 だけ外れる。
  //   ★ 202603・202604 は ② が空 (= 払っていない)。
  //   ★ user 2026-10-01 の見立て: **支給漏れをまとめて出した**のではないか。規模は合う:
  //       差 8,691 円 = 869 時間 = 52,146 分。彼女の月あたり訪問は 2,400〜4,200 分なので
  //       15〜22 か月ぶんに相当。入社 2023-02-15 → 勤続 1 年で対象 (2024-02) から
  //       202604 までが 26 か月なので 辻褄が合う。
  //   ⚠ ★ 当方の実績は **202604 以降しか無い**ので 正確な検算はできない (仮説どまり)。
  //   ⚠ 確認事項: ② の「総括表データ_パート」シートで 9,091 の出どころを確認する。
  //      まとめ払いなら 当方で再現する必要は無い (過去分の精算)。
  "1273400844|202605|230205|勤続手当": "支給漏れのまとめ払いと見られる (前後の月は単価どおり一致・規模も 15〜22 か月ぶんで整合)。user 2026-10-01 に許容と判断。出どころは要確認",
};

/** ① が介護超過を計算していない事業所 (② 側の式で出している)。2026-09-23 実測 */
const NO_CARE_OVERTIME_OFFICES = new Set(["1270501180", "1270105271"]);   // おゆみ野 / 中央

const RULES: Rule[] = [
  // ── 許容 (理由が確かめられているもの) ─────────────────────────────
  {
    item: "調整手当",
    verdict: "許容",
    reason:
      "総括表の「調整手当」= 介護超過(プラスのみ) + 夜朝深夜 + 特日 − 誤差。" +
      "★ 2026-09-24 に 762 人月で実測し 706 件 (92.7%) が 1 円一致。全 22 事業所で同じ式。" +
      "総括表は これらを個別の支給列として持たず 調整手当に畳み込んでいる。" +
      "★ 当方の内訳との突合は 下の「調整手当(内訳計)」で行う",
  },
  {
    item: "介護",
    verdict: "許容",
    reason: "★ 調整手当に畳み込まれている項目。突合は「調整手当(内訳計)」で行う (2026-09-24)",
    when: ({ ctx }) => ctx.adjustmentFolded === true,
  },
  {
    item: "夜朝深夜",
    verdict: "許容",
    reason: "★ 調整手当に畳み込まれている項目。突合は「調整手当(内訳計)」で行う (2026-09-24)",
    when: ({ ctx }) => ctx.adjustmentFolded === true,
  },
  {
    item: "特日",
    verdict: "許容",
    reason: "★ 調整手当に畳み込まれている項目。突合は「調整手当(内訳計)」で行う (2026-09-24)",
    when: ({ ctx }) => ctx.adjustmentFolded === true,
  },
  {
    item: "出勤時間",
    verdict: "許容",
    reason: "出勤簿の「勤務時間の欄」ではなく 終了−開始−休憩 で出している (user 2026-09-23)。欄は手入力で実態と合わない日がある",
    when: ({ ctx }) => ctx.attendanceGapMinutes !== 0,
  },
  {
    item: "残業総額",
    verdict: "許容",
    reason: "出勤時間が 欄と時刻で違うため。当システムは時刻を正とする",
    when: ({ ctx }) => ctx.attendanceGapMinutes !== 0,
  },
  {
    item: "本人給",
    verdict: "許容",
    reason:
      "事務員の本人給 = 出勤簿の時間 × 事務時給。出勤簿の「勤務時間の欄」と 終了−開始−休憩 が食い違う分だけずれる。" +
      "★ 出勤簿の 1 日の休憩欄が 0:00 のまま (同月の他の日は 1:00) という記入漏れが多い " +
      "(2026-09-24 実測: 時刻≠欄 120 行のうち 71 行が「1 日」)",
    when: ({ ctx }) => ctx.attendanceGapMinutes !== 0 && (ctx.roleType === "事務員" || Boolean(ctx.isOfficeWorker)),
  },
  {
    item: "介護",
    verdict: "許容",
    reason:
      "総括表の「介護」は **時間外h × 介護超過単価** をそのまま出した値で、訪問時間が閾値 (120h) に" +
      "届かない月は マイナスになる。総括表もマイナスの月は支給していない (調整手当に足していない)。" +
      "当システムは 0 を出す。★これが正 (user 2026-09-24)。" +
      "実証 (おゆみ野 峯島しおり): 時間外h −4.5 × 2,500 = −11,250 / −9.375 × 2,500 = −23,438 / " +
      "−2.125 × 2,500 = −5,313 と 総括表の「介護」が一致する",
    when: ({ soukatsu, ours }) => soukatsu < 0 && ours === 0,
  },
  {
    item: "介護",
    verdict: "許容",
    reason: "提責には介護超過手当を払わない (総括表の「提責・事務」区分 3 の 12 件すべてで ② は 0)",
    // ⚠ **事務員を外した (2026-09-24)。**事務員の「介護」列は 訪問分の給与 (office_worker_care_pay) で、
    //   許容にしたままだと 本物の設定漏れが隠れる (大網白里 稲葉香織 6 か月 ¥44,596 が実際に不足していた)
    when: ({ ctx, ours }) => ours === 0 && ctx.roleType === "提責",
  },
  {
    item: "介護",
    verdict: "要確認",
    reason: "この事業所は 総括表側の式で介護超過を出している (100〜120h を 800円/時・入浴件数×1.12h を足す)。式の再現を確かめる",
    when: ({ ctx }) => NO_CARE_OVERTIME_OFFICES.has(ctx.officeNumber),
  },
  {
    item: "有給休暇手当",
    verdict: "許容",
    reason:
      "総括表は 有給単価が空の月は 0 円で置き、単価が入った月に 未払ぶんをまとめて精算する。" +
      "月ごとには食い違うが 期間を通算すると一致する (2026-09-24 に 仁見初江で実証: " +
      "202604-06 の 4.5 日が未払 → 202607 に 当月 1 日と合算して 5.5 日 ¥64,719 で精算)",
    when: ({ ours, soukatsu }) => soukatsu === 0 && ours > 0,
  },
  {
    item: "有給休暇手当",
    verdict: "許容",
    reason:
      "総括表側が 過去の未払ぶんを上乗せして精算した月。当システムは その月の日数ぶんだけ出す。" +
      "★ 5.5 日という数字自体に意味は無い (未払の繰越量がたまたま揃っただけ)",
    when: ({ diff }) => diff > 0,
  },
  {
    item: "移動手当",
    verdict: "許容",
    reason: "旧システムの日別データと月計が食い違っている。日別を合計する形で 93.8% 一致が上限 (移行後に消える足場)",
  },

  // ── 要対応 ─────────────────────────────────────────────────────
  {
    item: "本人給",
    verdict: "要対応",
    reason: "単価が引けず 0 円で計算された訪問がある。サービスマスタで類型か時給を入れる",
    when: ({ ctx }) => ctx.hasRateGap,
  },
  {
    item: "集計項目小計",
    verdict: "要対応",
    reason: "単価が引けず 0 円で計算された訪問がある。サービスマスタで類型か時給を入れる",
    when: ({ ctx }) => ctx.hasRateGap,
  },
  {
    item: "出張費",
    verdict: "要対応",
    reason: "★ 事業所書式が丸ごと読めていない疑い (出張費も会議費も 0)。取込と Web 入力の合流を確かめる",
    when: ({ ours, ctx }) => ours === 0 && ctx.officeFormEmpty,
  },
  {
    item: "会議+研修",
    verdict: "要対応",
    reason: "★ 事業所書式が丸ごと読めていない疑い (出張費も会議費も 0)。取込と Web 入力の合流を確かめる",
    when: ({ ours, ctx }) => ours === 0 && ctx.officeFormEmpty,
  },
  {
    item: "出張費",
    verdict: "要対応",
    reason: "事業所書式の「出張km」が空の可能性。書式に入れる (検証中は 月ごとの手入力でも可)",
    when: ({ ours }) => ours === 0,
  },
  {
    item: "育児手当",
    verdict: "要対応",
    reason: "事業所書式に保育料の行が無い可能性。書式に入れる",
    when: ({ ours }) => ours === 0,
  },
  {
    item: "本人給",
    verdict: "要対応",
    reason: "出勤簿が当システムに 1 件も無い (事務員の本人給 = 出勤簿の時間 × 事務時給)",
    when: ({ ctx, ours }) => ctx.noAttendance && ours === 0 && (ctx.roleType === "事務員" || Boolean(ctx.isOfficeWorker)),
  },
  {
    item: "通勤費",
    verdict: "要対応",
    reason: "出勤簿が当システムに 1 件も無い (通勤費は出勤簿の通勤km から出す)",
    when: ({ ctx, ours }) => ctx.noAttendance && ours === 0,
  },
  {
    item: "調整手当(内訳計)",
    verdict: "許容",
    reason:
      "差が ② の「誤差」列と同額。★ 誤差 = ② が自分で記録している「システム総支給額 − 実際に払う額」で、" +
      "当方の 介護超過・夜朝深夜・特日 のどれでもない。★ 調整手当(内訳計) の ② 側は 誤差を引いた値なので " +
      "(soukatsuAdjustmentParts)、★ 3 部品が合っていても 誤差ぶんだけ必ずずれる。" +
      "2026-10-01 実測: 要確認 709 人月のうち 408 (全部 時給者) がこれ。うち 180 は 総支給も一致している " +
      "(= 金額に出ていない)。★ 総支給まで違う分は 総支給額 の行で見る",
    when: ({ diff, ctx }) => (ctx.soukatsuGosa ?? 0) !== 0 && Math.abs(diff + (ctx.soukatsuGosa as number)) <= MONEY_TOLERANCE,
  },
];

/** 1 項目ぶんの判定 */
export function judgeItem(item: string, ours: number, soukatsu: number, ctx: DiffContext): ItemDiff {
  const diff = soukatsu - ours;
  // ★ 1 件ずつ user が許容と判断したもの (規則にならないもの) を先に見る
  if (ctx.processingMonth && ctx.employeeNumber) {
    const known = KNOWN_DIFFS[`${ctx.officeNumber}|${ctx.processingMonth}|${ctx.employeeNumber}|${item}`];
    if (known) return { item, ours, soukatsu, diff, verdict: "許容", reason: known };
  }
  for (const r of RULES) {
    if (r.item !== item) continue;
    if (r.when && !r.when({ ours, soukatsu, diff, ctx })) continue;
    return { item, ours, soukatsu, diff, verdict: r.verdict, reason: r.reason };
  }
  return { item, ours, soukatsu, diff, verdict: "要確認", reason: "理由が分かっていない" };
}

/**
 * 総括表の「調整手当」の中身 (2026-09-24 に 762 人月で実測)。
 *
 * ★ **事業所ごとに違うのではなく 全 22 事業所で同じ式**だった。
 *   総括表は 介護超過・夜朝深夜・特日 を **個別の支給列として持たず 調整手当に畳み込んでいる**。
 *   当方はそれぞれ別項目で出すので、項目別に比べると「調整手当が当方 0 / 総括表が数十万」に見える。
 *
 * ```
 * 調整手当 = 介護超過 (プラスのときだけ) + 夜朝深夜 + 特日 − 誤差
 * ```
 *   介護+夜朝            451/762 (59.2%)
 *   + 特日              634/762 (83.2%)   ← 202608 は 特日 (8/13-15) があるので効く
 *   + 特日 − 誤差        **706/762 (92.7%)**  11 事業所は 100%
 *
 * ⚠ 介護超過は **マイナスの月は足さない**。総括表は 時間外h × 単価 の生値をセルに残すだけで
 *   支給していない (別途 実証済み)。
 */
export function soukatsuAdjustmentParts(row: Record<string, unknown>): {
  care: number; yocho: number; tokubi: number; gosa: number; total: number;
} {
  const care = Math.max(0, pickSoukatsu(row, "介護"));
  const yocho = Math.max(0, pickSoukatsu(row, "夜朝深夜"));
  const tokubi = pickSoukatsu(row, "特日2");
  const gosa = pickSoukatsu(row, "誤差");
  return { care, yocho, tokubi, gosa, total: care + yocho + tokubi - gosa };
}

/** 円の差がこれ以下なら「一致」とみなす (端数の丸め) */
export const MONEY_TOLERANCE = 1;

/** 項目ごとに突き合わせて、差があるものだけ返す */
export function diffItems(
  items: { item: string; ours: number; soukatsu: number }[],
  ctx: DiffContext,
): ItemDiff[] {
  return items
    .filter((x) => Math.abs(x.soukatsu - x.ours) > MONEY_TOLERANCE)
    .map((x) => judgeItem(x.item, x.ours, x.soukatsu, ctx))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}
