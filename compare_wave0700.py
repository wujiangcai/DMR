import xlrd, pathlib, math, statistics
files={
 'orig': pathlib.Path(r'C:\Users\caiwujiang\Documents\曲线.xls'),
 'w01': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_rec0700_20rows_field_01_wave.xls'),
 'w02': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_rec0700_20rows_field_02_wave.xls'),
 'w03': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_rec0700_20rows_field_03_wave.xls'),
}
def norm(v):
    if isinstance(v, str):
        s=v.strip()
        try:
            if s=='': return s
            return float(s)
        except: return s
    return v
def load(path):
    book=xlrd.open_workbook(str(path))
    sh=book.sheet_by_index(0)
    headers=[sh.cell_value(0,c) for c in range(sh.ncols)]
    rows=[]
    for r in range(1, sh.nrows): rows.append([norm(sh.cell_value(r,c)) for c in range(sh.ncols)])
    return headers, rows
loaded={}
for k,p in files.items():
    print('\n===',k,'===')
    print('path',p,'exists',p.exists(),'size',p.stat().st_size if p.exists() else None)
    h,rows=load(p); loaded[k]=(h,rows)
    print('rows',len(rows),'range', rows[0][1] if rows else None, '->', rows[-1][1] if rows else None)
    print('first', rows[0][:14] if rows else None)
orig=loaded['orig'][1]
orig_by_time={r[1]: r for r in orig}
for name in ['w01','w02','w03']:
    rows=loaded[name][1]
    print('\n===== DIFF',name,'=====')
    diffs=[]; col_counts={}
    for idx,r in enumerate(rows):
        o=orig_by_time.get(r[1])
        if not o: continue
        for c in range(2,min(len(r),len(o))):
            if r[c] != o[c]:
                diffs.append((idx+1,r[1],c,o[c],r[c], None if isinstance(r[c],str) or isinstance(o[c],str) else r[c]-o[c]))
                col_counts[c]=col_counts.get(c,0)+1
    print('diff count',len(diffs),'by col',col_counts)
    for d in diffs[:80]: print(d)
    print('last diffs')
    for d in diffs[-20:]: print(d)
    # summarize changed windows
    if diffs:
        times=[d[1] for d in diffs]
        print('first changed time',times[0],'last',times[-1])
        # by col stats
        for c in sorted(col_counts):
            ds=[d for d in diffs if d[2]==c]
            deltas=[d[5] for d in ds if isinstance(d[5],(int,float))]
            print('col',c,'header',loaded[name][0][c],'n',len(ds),'first',ds[:5],'delta stats', (min(deltas),max(deltas),sum(deltas)/len(deltas)) if deltas else None)
    # print rows around expected time range around 2023/11/06 10:56-11:40 maybe
    print('rows around changes:')
    shown=0
    for i,r in enumerate(rows):
        o=orig_by_time.get(r[1])
        if not o: continue
        changed=any(r[c]!=o[c] for c in range(2,14))
        if changed and shown<30:
            print('row',i+1,'time',r[1],'orig',o[2:14],'new',r[2:14])
            shown+=1
