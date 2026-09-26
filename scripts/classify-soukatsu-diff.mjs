/**
 * cmp/ の差分を 3 つに分ける (2026-09-21)。読み取りのみ・DB は書かない。
 *   ① 出勤簿があるべきなのに無い人      → データ不足。当方のバグではない
 *   ② 旧システムの出力(総括表データ_*)とは一致 → 総括表の支払側の上書き。当方のバグではない
 *   ③ どれとも違う                      → ★ 当方が本当に外している
 * 使い方:  SP=<cmp と soukatsu<YYYYMM> のある作業ディレクトリ> node scripts/classify-soukatsu-diff.mjs
 * 前提: scratchpad/cmp/*.txt と scratchpad/soukatsu<YYYYMM>/ があること
 */
import ExcelJS from "exceljs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
// 総括表 xlsm と 突合結果 cmp/*.txt の置き場。どちらも作業用ディレクトリにあるので env で渡す
const S = process.env.SP;
if (!S) { console.error("✗ SP に 作業ディレクトリ (cmp/ と soukatsu<YYYYMM>/ がある場所) を渡してください"); process.exit(1); }
const nn=s=>String(s??"").trim().replace(/^0+/,"");
// ★ ① の xlsm には カンマ付きの文字列 "15,631" が 922 セル (2026-09-27 実測)。外してから読む
const num=x=>{const v=(x&&typeof x==="object"&&"result"in x)?x.result:x;
  if (typeof v === "number") return Number.isFinite(v)?v:0;
  const n=Number(String(v??"").normalize("NFKC").replace(/[,s]/g,"")); return Number.isFinite(n)?n:0;};
const MAP_PART={ "移動手当":["移動手当"], "勤続":["勤続手当（パート）"], "育児":["育児手当"], "通勤":["通勤費"],
  "出張":["出張費"], "通信":["通信手当"], "補助金":["処遇改善補助金手当"], "土日祝":["土日祝"],
  "ドタキャン":["キャンセル手当（金額）"], "小計":["集計項目小計"], "残業":["残業手当総額_パート"],
  "会議+研修":["会議費","HRD研修費","研修費","初任者研修費"], "有給":["有給"] };
const MAP_SHA={ "育児":["育児手当"], "通勤":["通勤費"], "出張":["出張費"], "有給":["有給"],
  "勤続":["勤続手当"], "夜朝":["夜朝"], "残業":["残業手当総額"] };
const L1=new Map();
/** ①シートで その列が実際に埋まっているか。空の列と 0 を突き合わせると 偽の「一致」になる
 *  (2026-09-21 実測: 有給 0.0% / 通勤費 0.0% / 育児手当 1.9% は ①に入っていない) */
const COV={};
for(const m of ["202603","202604","202605","202606","202607"]){
  const root=join(S,`soukatsu${m}`); if(!existsSync(root))continue;
  for(const corp of readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()))
  for(const off of readdirSync(join(root,corp.name),{withFileTypes:true}).filter(d=>d.isDirectory()))
  for(const f of readdirSync(join(root,corp.name,off.name)).filter(f=>/_(パート|提責_社員)_\d{6}\.xlsm$/.test(f))){
    const kind=/パート/.test(f)?"part":"sha";
    const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(join(root,corp.name,off.name,f));
    const ws=wb.worksheets.find(w=>/^総括表データ_/.test(w.name)); if(!ws)continue;
    const h=ws.getRow(1).values; const cols={}; h.forEach((x,i)=>{const k=String(x??"").trim(); if(k&&!(k in cols))cols[k]=i;});
    if(!cols["従業員コード"])continue;
    for(let r=2;r<=ws.rowCount;r++){
      const v=ws.getRow(r).values; const emp=nn(v[cols["従業員コード"]]); if(!emp)continue;
      L1.set(`${off.name}|${m}|${emp}`,{kind,v,cols});
      for(const c of Object.keys(cols)){const k=`${kind}/${c}`; const s2=COV[k]??(COV[k]={n:0,nz:0}); s2.n++; if(num(v[cols[c]])!==0)s2.nz++;}
    }
  }
}
const zero=new Set(), rows=[];
for(const f of readdirSync(`${S}/cmp`).filter(f=>f.endsWith(".txt"))){
  const mm=/^(.*)_(\d{6})\.txt$/.exec(f);
  for(const l of readFileSync(`${S}/cmp/${f}`,"utf8").split("\n")){
    const g=/^\s+(時給|月給) (\S+) (.*?) 差(-?\d+) : (.*)$/.exec(l); if(!g)continue;
    const items=g[5].split(", ").filter(Boolean).map(s=>{const m2=/^(\S+) (-?\d+)\/(-?\d+)$/.exec(s); return m2?{k:m2[1],a:+m2[2],b:+m2[3]}:null}).filter(Boolean);
    const key=mm[1]+"|"+nn(g[2]);
    if(items.length>1&&items.every(i=>i.a===0&&i.b!==0)) zero.add(key);
    rows.push({off:mm[1],m:mm[2],emp:nn(g[2]),name:g[3].trim(),items,key});
  }
}
const st={}; let aAbs=0,aN=0;
for(const r of rows) for(const i of r.items){ if(zero.has(r.key)){aN++; aAbs+=Math.abs(i.a-i.b);} }
const real=[];
for(const r of rows){
  if(zero.has(r.key))continue;
  const l1=L1.get(`${r.off}|${r.m}|${r.emp}`);
  for(const i of r.items){
    const s=st[i.k]??(st[i.k]={n:0,abs:0,ok:0,okAbs:0});
    const d=Math.abs(i.a-i.b); s.n++; s.abs+=d;
    const map=(l1?.kind==="part"?MAP_PART:MAP_SHA)[i.k];
    // ★ 空の列は証拠にならない。1 つでも「埋まっている列」がある組み合わせだけ採用する
    const have=(l1&&map)?map.filter(c=>l1.cols[c]):[];
    const usable=have.some(c=>{const cv=COV[`${l1.kind}/${c}`]; return cv && cv.nz/cv.n>=0.05;});
    if(usable&&have.reduce((a,c)=>a+num(l1.v[l1.cols[c]]),0)===i.a){ s.ok++; s.okAbs+=d; }
    else real.push({...r,item:i.k,ours:i.a,sou:i.b,d});
  }
}
console.log(`① 出勤簿があるべきなのに無い人: ${aN}項目 ¥${aAbs.toLocaleString()}`);
console.log("\n残り (項目 / 件数 / 絶対額 / ②総括表側の上書き / ★当方の残差)");
let t=0,to=0;
for(const [k,v] of Object.entries(st).sort((a,b)=>(b[1].abs-b[1].okAbs)-(a[1].abs-a[1].okAbs))){
  t+=v.abs; to+=v.okAbs;
  console.log(`  ${k.padEnd(9)}${String(v.n).padStart(5)}件 ¥${String(v.abs.toLocaleString()).padStart(9)}   ②${String(v.ok).padStart(4)}件 ¥${String(v.okAbs.toLocaleString()).padStart(9)}   ★¥${(v.abs-v.okAbs).toLocaleString()}`);
}
console.log("-".repeat(78));
console.log(`  合計 ¥${t.toLocaleString()}  /  ② ¥${to.toLocaleString()} (${(to/t*100).toFixed(1)}%)  /  ★当方の残差 ¥${(t-to).toLocaleString()}`);
