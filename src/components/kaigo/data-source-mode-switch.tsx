"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import {
  setJissekiSourceMode,
  type JissekiSourceMode,
} from "@/lib/app-settings";

const MODES: { value: JissekiSourceMode; label: string; description: string }[] = [
  {
    value: "csv",
    label: "CSV 取込モード",
    description: "ほのぼの等から出力した CSV ファイルで実績を取り込む (従来)",
  },
  {
    value: "kaigo",
    label: "介護システム直接モード",
    description: "kaigo-app の実績確定データを「取り込み」ボタンで snapshot 取込する",
  },
];

/** 実績データ取込元モードの切替スイッチ (payroll_app_settings に保存) */
export function DataSourceModeSwitch({ initialMode }: { initialMode: JissekiSourceMode }) {
  const [mode, setMode] = useState<JissekiSourceMode>(initialMode);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  const handleChange = async (next: JissekiSourceMode) => {
    if (next === mode || saving) return;
    setSaving(true);
    const errMsg = await setJissekiSourceMode(supabase, next);
    setSaving(false);
    if (errMsg) {
      toast.error(
        `モード切替失敗: ${errMsg} (migration payroll_data_source_mode_v1.sql 未適用の可能性)`,
      );
      return;
    }
    setMode(next);
    toast.success(`${MODES.find((m) => m.value === next)!.label}に切り替えました`);
    router.refresh();
  };

  const current = MODES.find((m) => m.value === mode)!;

  return (
    <div className="rounded-md border px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm">
        <span className="font-semibold">実績データの取込元:</span>
        <span className="text-muted-foreground ml-2">{current.description}</span>
      </div>
      <div className="flex rounded-md border overflow-hidden">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            disabled={saving}
            onClick={() => handleChange(m.value)}
            className={`px-3 py-1.5 text-xs transition-colors ${
              mode === m.value
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-background hover:bg-muted"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
