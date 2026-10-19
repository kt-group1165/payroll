"""ケアマネの出勤簿 (Excel・1 人 1 冊・シートが月ごと) から 日ごとの 出社・退社・就業時間・移動距離・備考 を抜き出す (2026-10-19)。

  元: Box 8F/佐藤千鶴/19_事業所出勤簿/<M>月/<KT|S・G>/<拠点>/*.xlsx  (★ 読むだけ。編集・上書き禁止)
      ★ 先に scratchpad 等へ コピーしてから読む (Git Bash の cp は権限エラーになる月がある。PowerShell の Copy-Item なら通る)
      ★ M 月の分は M 月のフォルダの版を使う (総括表は その版で作られている。7 月の分を 8 月のフォルダの版で読むと 合わない人が増える)

  python -I migrations/_parse_cm_attendance_books.py <コピーした M 月フォルダ> > cm_days.json
  → npx tsx migrations/import_kyotaku_attendance_from_cm_books.mts cm_days.json 2026-06   (DRY RUN)

・シートの年月は 1 行目の題名 (「2026年 7月 出勤簿」「２０２6年 ７月」「2026  6月」/ 数字のセル) から取る。
  行の日付 (A 列) が 日付型ならその日、数字なら 題名の年月の日。
  ★ 題名の月と違う日付の行は 使わない (型紙をコピーしたまま 日付が前の月のシートがある。八千代 寺﨑 2026.8 に 4 月の日付)
  ★ 日付型の行は 月だけ見る (船橋 高橋の 2026 年のシートは 題名の年が 型紙の 2025 のまま)
・就業時間: 見出しの列か その 1 つ左 (八千代・船橋は 見出しが 1 列ずれている) の数字
・移動距離の「198,7」(小数点がカンマ) も数字として読む (出勤簿の合計の式は数えないが 総括表は数えている。土屋 2026-06)
・同じ人の同じ日が 2 つのシートにあって値が違うときは conflicts に出す (距離が入っている方 → 無ければ 先に読んだ方を使う)
・下の欄 (介護件数・予防件数・認定調査) は monthly に出す。総括表と一致 (6月 出勤簿がある 89 人中): 予防 86 / 調査 85 / 介護 83。
  加算の欄は 書き方がばらばらで 52〜76 人しか合わないので 読まない
・2026-06〜09 の総括表 (ケアマネ) と 人月で突き合わせた結果: 距離が一致 6月 89/90・7月 88/90・8月 86/91・9月 91/93 (分母は総括表の人数)
"""
import openpyxl, glob, os, sys, json, datetime, re, unicodedata

def norm(s):
    return re.sub(r'[\s　\t]', '', unicodedata.normalize('NFKC', str(s or '')))

def tmin(v):
    if isinstance(v, (datetime.time, datetime.datetime)): return v.hour * 60 + v.minute
    if isinstance(v, (int, float)) and 0 < v < 1: return round(v * 24 * 60)
    return None

def cnt_num(v):
    """下の欄の件数: 数字 / 「26件」「３３件」/ 「14+2(月遅れ)」(足す)。空・「件」だけは None"""
    if isinstance(v, bool): return None
    if isinstance(v, (int, float)): return v
    if isinstance(v, str):
        t = unicodedata.normalize('NFKC', v).replace(',', '').strip()
        m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(?:件|回)?(?:[（(].*)?', t)
        if m: return float(m.group(1))
        m = re.fullmatch(r'(\d+)\s*\+\s*(\d+).*', t)
        if m: return float(m.group(1)) + float(m.group(2))
    return None

def sheet_ym(rows):
    t = ' '.join(unicodedata.normalize('NFKC', str(c)) for r in rows[:3] for c in r if c is not None)
    # 「2026 年 7月」「２０２6年 ７月」「2026  6月」(年が無い 五井 三枝) のどれも
    m = re.search(r'(20\d\d)\s*年?\s*(\d{1,2})\s*月', t)
    if m: return int(m.group(1)), int(m.group(2))
    nums = [c for c in rows[0] if isinstance(c, (int, float))]
    if len(nums) >= 2 and 2000 < nums[0] < 2100 and 1 <= nums[1] <= 12: return int(nums[0]), int(nums[1])
    return None

out, conflicts, skipped = {}, [], []
monthly = {}   # 拠点|氏名|YYYY-MM → 出勤簿の下の欄 (介護件数・予防件数・認定調査)。本人が書いた数字
for f in sorted(glob.glob(os.path.join(sys.argv[1], '**', '*.xls*'), recursive=True)):
    area = os.path.basename(os.path.dirname(f))
    try: wb = openpyxl.load_workbook(f, data_only=True, read_only=True)
    except Exception as e: skipped.append(f'{f}: {e}'); continue
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        if len(rows) < 8: continue
        ym = sheet_ym(rows)
        name = None
        for r in rows[1:4]:
            for c in r:
                if isinstance(c, str) and norm(c) and not re.search(r'事業所|センター|居宅|ケア|Hana|ＫＴ|KT|リンクス|ムツミ|八千代|船橋|大網|五井|年|月|出勤簿', unicodedata.normalize('NFKC', c)):
                    name = name or norm(c)
        hi = next((i for i, r in enumerate(rows[:12]) if any(isinstance(c, str) and '移動距離' in c for c in r if c)), None)
        if hi is None or not name or not ym: continue
        h = [norm(c) for c in rows[hi]]
        col = lambda key: next((i for i, c in enumerate(h) if key in c), None)
        cs, ce, ch, ck, cn = col('出社'), col('退社'), col('就業'), col('移動距離'), col('備考')
        # 下の欄 (「合計」の行の下): 介護件数 / 予防件数 / 認定調査。★ 行の日付が この月のシートだけ (型紙の残りを拾わない)
        dated = [r[0] for r in rows[hi + 1:] if r and isinstance(r[0], datetime.datetime)]
        if not dated or any(d.month == ym[1] for d in dated):
            ti = next((k for k, r in enumerate(rows) if r and isinstance(r[0], str) and r[0].strip() == '合計'), None)
            if ti is not None:
                info = {}
                for r in rows[ti + 1:ti + 8]:
                    cells = [c for c in r[:16] if c is not None and str(c).strip() != '']
                    if len(cells) < 2: continue
                    lab = unicodedata.normalize('NFKC', str(cells[0]))
                    k2 = 'kaigo' if '介護件数' in lab else 'yobou' if '予防件数' in lab else 'survey' if '認定調査' in lab else None
                    if k2 and k2 not in info: info[k2] = cnt_num(cells[1])
                if info:
                    mk = f'{area}|{name}|{ym[0]}-{ym[1]:02d}'
                    if mk not in monthly or (not any(monthly[mk].values()) and any(info.values())):
                        monthly[mk] = dict(info, sheet=ws.title, file=os.path.basename(f))
        for r in rows[hi + 1:]:
            if not r: continue
            d0 = r[0]
            if isinstance(d0, datetime.datetime): day = d0.date()
            elif isinstance(d0, (int, float)) and 1 <= d0 <= 31:
                try: day = datetime.date(ym[0], ym[1], int(d0))
                except ValueError: continue
            else: continue
            # 日付型の行は 月だけ見る (船橋 高橋の 2026 年のシートは 題名の年が 型紙の 2025 のまま)
            if day.month != ym[1] or (not isinstance(d0, datetime.datetime) and day.year != ym[0]): continue
            g = lambda i: r[i] if i is not None and i < len(r) else None
            hours = next((v for v in (g(ch), g(ch - 1) if ch else None) if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v <= 24), None)
            s, e = tmin(g(cs)), tmin(g(ce))
            km = g(ck)
            # 「198,7」のように 小数点をカンマで書いた値 (出勤簿の合計の式は数えないが 総括表は数えている。土屋 2026-06)
            if isinstance(km, str) and re.fullmatch(r'\s*\d+[,，.．]\d+\s*', unicodedata.normalize('NFKC', km)):
                km = float(re.sub(r'[,，．]', '.', unicodedata.normalize('NFKC', km).strip()))
            note = g(cn)
            note = str(note).strip() if note not in (None, '') else None
            if isinstance(g(cs), str) and not note: note = g(cs).strip()   # 「公休」「有給」を出社の欄に書く人がいる
            rec = dict(start=s, end=e, hours=hours, km=km if isinstance(km, (int, float)) and not isinstance(km, bool) else None, note=note)
            if rec['start'] is None and rec['km'] is None and rec['hours'] is None and not rec['note']: continue
            key = f'{area}|{name}|{day.isoformat()}'
            if key in out and out[key]['rec'] != rec:
                conflicts.append(dict(key=key, a=out[key], b=dict(rec=rec, file=os.path.basename(f), sheet=ws.title)))
                # 距離が入っている方を使う (五井 平床: 8 月用のシート R8.8 が 7 月の題名・日付のまま 距離だけ空で残っていた)
                if out[key]['rec']['km'] is None and rec['km'] is not None:
                    out[key] = dict(rec=rec, file=os.path.basename(f), sheet=ws.title)
                continue
            out.setdefault(key, dict(rec=rec, file=os.path.basename(f), sheet=ws.title))
json.dump(dict(days=out, monthly=monthly, conflicts=conflicts, skipped=skipped), sys.stdout, ensure_ascii=False, default=str)
