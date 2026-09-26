<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- ここから下は KT Group が書いたもの。上の BEGIN/END ブロックは Next.js が自動管理するので触らない -->

## 上の注意書きの運用 (2026-09-26 user 判断)

上のブロックは `create-next-app` が自動で置いた定型文で、**KT Group が書いたものではない**。
ただし **この警告は実在する罠を指している**ので無視はしない。実際に踏んだもの:

- `tsc` は通るのに **Turbopack のビルドが落ちた** (サービス名の中黒「・」を未クォートの
  オブジェクトキーにしていた)。★ push 成功 ≠ deploy 成功
- ルートの `node_modules/next` が 16.2.1 のまま取り残されており、
  `node ../../node_modules/next/dist/bin/next build` を使うと `InvariantError` を必ず踏む
  → ★ **`apps/payroll-app` 自身の `node_modules/next` を使う** (`../../` を付けない)

### いつ `node_modules/next/dist/docs/` を読むか

```
読まなくてよい   既にこのリポジトリで動いているパターンを そのまま真似するだけのとき
                 (例: useSyncExternalStore で localStorage を読む / Link / usePathname /
                      既存のページに列を足す / 既存の関数の中身を直す)
                 ★ 動いているコードの真似なので バージョン差の影響を受けようがない

★ 必ず読む      このリポジトリにまだ無い Next.js の機能を使うとき
                 (例: 新しいルーティング規約・キャッシュ/再検証の指定・Server Actions・
                      middleware・metadata・画像や font の新 API・新しいファイル名規約)
                 ★ 「たぶん前のバージョンと同じ」で書かない。ここが壊れると build が落ちる
```

### どちらでも守ること

- 変更したら `npx tsc --noEmit` と `npx eslint <触ったファイル>` を通す
- ★ **伝送系マスタや オブジェクトキーに記号が入る変更をしたら build も回す** (tsc をすり抜ける)
- 画面の変更は **実際にブラウザで動かして確認**してから完了と言う
