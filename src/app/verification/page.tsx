import VerificationContent from "./verification-content";

/**
 * /verification 総括表との検証
 *
 * 移行期だけの画面。旧システムの総括表 (実際に払った額) と 当システムの計算結果を
 * 職員ごと・項目ごとに突き合わせ、**どこがどうずれているか**と
 * **直す必要があるか (要対応) / 追いかけなくてよいか (許容)** を出す。
 * 本稼働後は総括表が無くなるので この画面ごと落とす。
 */
export const dynamic = "force-dynamic";

export default function VerificationPage() {
  return <VerificationContent />;
}
