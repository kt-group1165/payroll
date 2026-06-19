/**
 * 一括 CSV 取込 (= /csv-import/batch) 用の共通型。
 *
 * フォルダドロップで複数 CSV を一気に取り込むための骨格:
 *   - detect: file 内容/ファイル名から種別・事業所番号・年月を推測
 *   - process: 既存 importer の DB INSERT ロジックを呼び出す薄い wrapper
 *
 * 既存 importer (kyotaku / yobou / meisai / billing) の UI 単発取込は
 * 一切壊さない。process* 関数は各 importer ファイルに併設し、UI 内ロジックを
 * 関数化したものを batch UI からも呼べるようにする。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ImporterKind = "kyotaku" | "yobou" | "meisai" | "billing";

export const IMPORTER_LABELS: Record<ImporterKind, string> = {
  kyotaku: "居宅実績 (国保連)",
  yobou: "介護予防件数",
  meisai: "介護ソフト明細",
  billing: "請求 CSV",
};

/**
 * 自動判定結果。
 *  - kind: importer 種別 (unknown なら手動指定が必要)
 *  - officeNumber: CSV / ファイル名から推定した事業所番号 (10 桁数字想定、見つからなければ null)
 *  - yearMonth: "YYYY-MM" 形式の対象月。種別によっては CSV 内に複数月が混在し得るので注意:
 *      - kyotaku/yobou: parser が rows 内 service_month を保持するため UI hint としてのみ使う
 *      - meisai: DB INSERT に必須 (= 処理月)、自動推定 or ユーザー指定
 *  - rowCount: 推定行数 (ヘッダ抜き)。0 ならパース失敗もしくは空ファイル
 *  - confidence:
 *      - high   : 種別 + officeNumber + yearMonth が全て自信を持って決まった
 *      - medium : 種別は分かったが事業所 or 年月が一部欠落
 *      - low    : 種別不明 or パースに失敗気味
 */
export type DetectResult = {
  kind: ImporterKind | "unknown";
  officeNumber: string | null;
  yearMonth: string | null;
  rowCount: number;
  confidence: "high" | "medium" | "low";
  notes?: string;
};

/**
 * batch UI から呼ぶ DB INSERT の結果。
 * 既存 importer は toast & state でユーザーにフィードバックするが、batch UI は
 * file ごとの sub-result を集約して 1 枚のサマリにする。
 *  - inserted: 新規 INSERT 件数
 *  - skipped : 重複/上書き skip 件数 (upsert ignoreDuplicates 由来)
 *  - failed  : chunk INSERT が error した件数
 *  - errors  : サマリ上に表示する error message (最大 5 件、超過分は console)
 */
export type ProcessResult = {
  inserted: number;
  failed: number;
  skipped: number;
  errors: string[];
};

/**
 * 各 importer 種別ごとに共通のシグネチャで wrap した handler。
 *  - detect: 純粋関数 (副作用なし)。CSV テキスト + ファイル名から DetectResult を返す
 *  - process: tenant + 解決済み officeNumber/yearMonth を受けて DB INSERT を実行
 *
 * supabase は SSR client / browser client いずれも互換 (SupabaseClient<any>)。
 */
export type ProcessOpts = {
  tenantId: string;
  officeNumber: string;
  /** YYYY-MM 形式 (kyotaku/yobou は CSV 由来、meisai はユーザー指定) */
  yearMonth: string;
  /** 1 file = 1 source_filename。billing 等は 1 file 内で複数事業所も理論上あり得るが batch では単一前提 */
  sourceFilename: string;
  supabase: SupabaseClient;
};

export type ImportHandler = {
  kind: ImporterKind;
  detect: (text: string, filename: string) => DetectResult;
  process: (text: string, opts: ProcessOpts) => Promise<ProcessResult>;
};
