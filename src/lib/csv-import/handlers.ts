/**
 * batch UI 用の ImportHandler レジストリ。
 *
 * 各 importer の process 実体は当該 component 横に置いてあるため、ここでは
 * detect 関数 (detectFromText) と組み合わせるだけのシン wrapper。
 *
 * 注: billing は alias 解決が必要なため、batch では「検出はするが取込実行は不可」
 *     として handler を提供しない (UI で skip メッセージを出す)。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectFromText } from "./detect";
import type { ImporterKind, ImportHandler, ProcessResult } from "./types";
import { processKyotakuCsvFromBuffer } from "@/components/csv/kyotaku-importer";
import { processYobouCsvFromBuffer } from "@/components/csv/yobou-importer";
import { processMeisaiCsvFromFile } from "@/components/csv/meisai-importer";

/**
 * batch UI が file ごとに保持する「生 buffer + file + decoded text」のラッパー。
 * detect には text、process には buffer or file を渡す必要があるため一緒に保持する。
 */
export type FilePayload = {
  file: File;
  buffer: ArrayBuffer;
  text: string;
};

/**
 * batch UI から呼ぶ統一 API。kind ごとに ProcessResult を返す。
 *
 * 引数:
 *   - kind: 確定済み importer 種別
 *   - payload: file + 生 buffer + decoded text
 *   - tenantId / officeNumber / yearMonth: ユーザー確定後の値
 *   - supabase: SSR / browser いずれも互換
 */
export async function runImport(
  kind: ImporterKind,
  payload: FilePayload,
  args: {
    tenantId: string;
    officeNumber: string;
    /** YYYY-MM 形式 */
    yearMonth: string;
    supabase: SupabaseClient;
  },
): Promise<ProcessResult> {
  switch (kind) {
    case "kyotaku":
      return processKyotakuCsvFromBuffer(payload.buffer, {
        tenantId: args.tenantId,
        officeNumber: args.officeNumber,
        sourceFilename: payload.file.name,
        supabase: args.supabase,
      });
    case "yobou":
      return processYobouCsvFromBuffer(payload.buffer, {
        tenantId: args.tenantId,
        officeNumber: args.officeNumber,
        sourceFilename: payload.file.name,
        supabase: args.supabase,
      });
    case "meisai":
      return processMeisaiCsvFromFile(payload.file, {
        officeNumber: args.officeNumber,
        processingMonth: args.yearMonth.replace("-", ""), // YYYYMM
        supabase: args.supabase,
      });
    case "billing":
      // billing は alias 解決が必要なので batch では未サポート
      return {
        inserted: 0,
        skipped: 0,
        failed: 0,
        errors: ["請求 CSV は /billing/import で取込んでください (alias 設定が必要)"],
      };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return {
        inserted: 0,
        skipped: 0,
        failed: 0,
        errors: [`未対応の種別: ${kind}`],
      };
    }
  }
}

/** detect の re-export (UI で使いやすく) */
export { detectFromText };

/**
 * 簡易 ImportHandler の型 (= 既存 handler パターンとの整合のため公開しておく)。
 * detect は同期 (テキスト渡し)、process は buffer 渡しで非同期。
 */
export const handlers: Record<Exclude<ImporterKind, never>, ImportHandler> = {
  kyotaku: {
    kind: "kyotaku",
    detect: (text, filename) => detectFromText(text, filename),
    process: async () => {
      throw new Error("ImportHandler.process は使用しません。runImport() を使ってください");
    },
  },
  yobou: {
    kind: "yobou",
    detect: (text, filename) => detectFromText(text, filename),
    process: async () => {
      throw new Error("ImportHandler.process は使用しません。runImport() を使ってください");
    },
  },
  meisai: {
    kind: "meisai",
    detect: (text, filename) => detectFromText(text, filename),
    process: async () => {
      throw new Error("ImportHandler.process は使用しません。runImport() を使ってください");
    },
  },
  billing: {
    kind: "billing",
    detect: (text, filename) => detectFromText(text, filename),
    process: async () => ({
      inserted: 0,
      skipped: 0,
      failed: 0,
      errors: ["請求 CSV は /billing/import で取込んでください"],
    }),
  },
};
