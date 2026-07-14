/**
 * /csv-import のスケルトン。件数集計 fetch 中もクリック直後に画面が切り替わるようにする
 * (これが無いと Server Component の応答までナビが「無反応」に見える)。
 */
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-56 bg-muted rounded mb-6" />
      <div className="h-14 bg-muted/60 rounded-md mb-4" />
      <div className="h-12 bg-muted/60 rounded-md mb-4" />
      <div className="flex gap-2 mb-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-9 w-28 bg-muted rounded-md" />
        ))}
      </div>
      <div className="h-64 bg-muted/40 rounded-md" />
    </div>
  );
}
