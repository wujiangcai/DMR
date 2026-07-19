import xlrd, pathlib
files={
 'w01': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_rec0700_20rows_field_01_wave.xls'),
 'w02': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_rec0700_20rows_field_02_wave.xls'),
 'w03': pathlib.Path(r'C:\Users\caiwujiang\Documents\DAT0131_probe_rec0700_20rows_field_03_wave.xls'),
}
origp=pathlib.Path(r'C:\Users\caiwujiang\Documents\曲线.xls')
def norm(v):
    if isinstance(v,str):
        s=v.strip()
        try: return float(s)
        except: return s
    return v
def load(p):
    b=xlrd.open_workbook(str(p)); sh=b.sheet_by_index(0)
    return [sh.cell_value(0,c) for c in range(sh.ncols)], [[norm(sh.cell_value(r,c)) for c in range(sh.ncols)] for r in range(1,sh.nrows)]
h,orig=load(origp); ob={r[1]:r for r in orig}
for name,p in files.items():
    h,rows=load(p)
    meaningful=[]
    for idx,r in enumerate(rows):
        o=ob.get(r[1])
        if not o: continue
        for c in range(2,14):
            if r[c]!=o[c] and not (o[c]==-32640.0 and r[c]==0.0):
                meaningful.append((idx+1,r[1],c,h[c],o[c],r[c],r[c]-o[c] if isinstance(r[c],float) and isinstance(o[c],float) else None))
    print('\n',name,'meaningful diffs',len(meaningful))
    by={}
    for d in meaningful: by[d[2]]=by.get(d[2],0)+1
    print('by col', {h[k]:v for k,v in by.items()})
    for d in meaningful[:60]: print(d)
