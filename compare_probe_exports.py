import xlrd, pathlib, json, math
files={
 'orig': pathlib.Path(r'C:\Users\caiwujiang\Documents\曲线.xls'),
 'step': pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131_probe_first_record_step_values.xls'),
 'ramp': pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131_probe_field_00_first_10_rows_ramp.xls'),
}
def load(p):
    book=xlrd.open_workbook(str(p))
    sh=book.sheet_by_index(0)
    headers=[sh.cell_value(0,c) for c in range(sh.ncols)]
    rows=[]
    for r in range(1, sh.nrows):
        rows.append([sh.cell_value(r,c) for c in range(sh.ncols)])
    return headers, rows
loaded={}
for k,p in files.items():
    print('\n===',k,p,'exists',p.exists(),'size',p.stat().st_size if p.exists() else None,'===')
    h,rows=load(p)
    loaded[k]=(h,rows)
    print('headers',h)
    print('rows',len(rows))
    for i in range(min(12,len(rows))):
        print(i+1, rows[i][:14])
# compare all cells
orig=loaded['orig'][1]
for name in ['step','ramp']:
    rows=loaded[name][1]
    diffs=[]
    for r in range(min(len(orig),len(rows))):
        for c in range(min(len(orig[r]),len(rows[r]))):
            if orig[r][c] != rows[r][c]:
                diffs.append((r+1,c,orig[r][c],rows[r][c]))
                if len(diffs)>=100: break
        if len(diffs)>=100: break
    print('\nDIFF',name,'count first100',len(diffs))
    for d in diffs[:50]: print(d)
    # per column diff counts
    counts={}
    for r in range(min(len(orig),len(rows))):
        for c in range(min(len(orig[r]),len(rows[r]))):
            if orig[r][c] != rows[r][c]: counts[c]=counts.get(c,0)+1
    print('diff counts by col',counts)
