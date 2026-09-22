/**
 * 全画面共通のスケルトン (2026-09-22「左メニューの遷移が遅い」)。
 * これが無いと Server Component の応答が返るまで クリックしても画面が変わらず「無反応」に見える。
 * 専用の loading.tsx がある画面 (csv-import 等) はそちらが優先される。
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="読み込み中">
      <div className="h-8 w-56 bg-muted rounded mb-6" />
      <div className="flex gap-2 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-28 bg-muted rounded-md" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-10 bg-muted/50 rounded-md" />
        ))}
      </div>
    </div>
  );
}
