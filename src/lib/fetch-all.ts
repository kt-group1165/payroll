/**
 * 大きい table を PostgREST の 1000 行上限を回避しつつ高速に全件取得するための
 * ヘルパー。
 *
 * 既存の page-loop 方式 (1 ページずつ順次 await) は 10,000 行で 10 round trip × 数百ms
 * = 数秒の wait になりがち。ここでは:
 *
 * 1. `count: "exact", head: true` で row 数だけ取得 (1 round trip)
 * 2. ceil(total / pageSize) 本の range クエリを `Promise.all` で同時発火 (1 round trip 相当)
 *
 * 結果として「count + 1 並列 round trip」≒ 2 round trip 相当で全件取得できる。
 *
 * 注意: PostgREST は 1 接続で同時発火を捌くため数十並列でも問題ないが、極端に大きい
 * table (>50,000 行) は memory もそれなり積むので呼び出し側で chunk 上限を意識する。
 */

type CountResult = { count: number | null };
type PageResult<T> = { data: T[] | null };

/**
 * count → 並列 range 発火で全件取得。
 *
 * 呼び出し側が count query と page query (range 引数を受け取る) を closure で渡す。
 * 並列発火のため各 page は独立した query instance である必要がある。
 *
 * @example
 * const clients = await fetchAllPagesParallel<Client>(
 *   () => supabase.from("payroll_clients").select("*", { count: "exact", head: true }),
 *   (from, to) => supabase.from("payroll_clients").select("*").order("client_number").range(from, to),
 * );
 */
export async function fetchAllPagesParallel<T>(
  buildCountQuery: () => PromiseLike<CountResult>,
  buildPageQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
): Promise<T[]> {
  const { count } = await buildCountQuery();
  const total = count ?? 0;
  if (total === 0) return [];

  const numPages = Math.ceil(total / pageSize);
  const requests: PromiseLike<PageResult<T>>[] = [];
  for (let i = 0; i < numPages; i++) {
    const from = i * pageSize;
    const to = Math.min(from + pageSize - 1, total - 1);
    requests.push(buildPageQuery(from, to));
  }
  const responses = await Promise.all(requests);
  const all: T[] = [];
  for (const r of responses) {
    if (r.data) all.push(...r.data);
  }
  return all;
}
