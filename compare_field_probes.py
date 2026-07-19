import xlrd, pathlib, math
files={
 'orig': pathlib.Path(r'C:\Users\caiwujiang\Documents\曲线.xls'),
 'f01': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_first_field_01_to_30000.xls'),
 'f02': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_first_field_02_to_30000.xls'),
 'f03': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_first_field_03_to_30000.xls'),
}

def norm(v):
    if isinstance(v, str):
        s=v.strip()
        try:
            if s == '': return s
            return float(s)
        except Exception:
            return s
    return v

def load(p):
    book=xlrd.open_workbook(str(p))
    sh=book.sheet_by_index(0)
    headers=[sh.cell_value(0,c) for c in range(sh.ncols)]
    rows=[]
    for r in range(1, sh.nrows):
        rows.append([norm(sh.cell_value(r,c)) for c in range(sh.ncols)])
    return headers, rows
loaded={}
for k,p in files.items():
    print('\n===',k,'===')
    print('path',p,'exists',p.exists(),'size',p.stat().st_size if p.exists() else None)
    h,rows=load(p)
    loaded[k]=(h,rows)
    print('rows',len(rows),'cols',len(h))
    print('first',rows[0][:14] if rows else None)
    print('last',rows[-1][:14] if rows else None)
    for i in range(min(5,len(rows))): print(i+1, rows[i][:14])

orig=loaded['orig'][1]
# Build map by time for robust compare
orig_by_time={r[1]: r for r in orig}
for name in ['f01','f02','f03']:
    rows=loaded[name][1]
    print('\n===== COMPARE',name,'=====')
    print('row count',len(rows),'time range', rows[0][1] if rows else None, '->', rows[-1][1] if rows else None)
    same_time=sum(1 for r in rows if r[1] in orig_by_time)
    print('times found in original',same_time,'/',len(rows))
    diffs=[]
    col_counts={}
    value_changes=[]
    for ri,r in enumerate(rows):
        o=orig_by_time.get(r[1])
        if not o: continue
        for c in range(2,min(len(r),len(o))):
            if r[c] != o[c]:
                diffs.append((r[1], c, o[c], r[c]))
                col_counts[c]=col_counts.get(c,0)+1
                if len(value_changes)<80: value_changes.append((r[1], c, o[c], r[c]))
    print('value diffs matching same time',len(diffs),'by col',col_counts)
    for d in value_changes[:40]: print('diff',d)
    # Also compare by row index for first 20
    print('first 20 row-index diffs:')
    cnt=0
    for i in range(min(20,len(rows),len(orig))):
        rowdiff=[]
        for c in range(1,14):
            if rows[i][c] != orig[i][c]: rowdiff.append((c,orig[i][c],rows[i][c]))
        if rowdiff:
            print('row',i+1,rowdiff[:8])
            cnt+=1
    if cnt==0: print('none')
