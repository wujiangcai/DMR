import xlrd, pathlib, json, math
p=pathlib.Path(r'C:\Users\caiwujiang\Documents\曲线.xls')
book=xlrd.open_workbook(str(p), formatting_info=False)
print('sheets', book.sheet_names())
for si, sh in enumerate(book.sheets()):
    print('\n--- sheet', si, sh.name, 'rows', sh.nrows, 'cols', sh.ncols, '---')
    for r in range(min(sh.nrows, 30)):
        vals=[]
        for c in range(min(sh.ncols, 12)):
            v=sh.cell_value(r,c)
            t=sh.cell_type(r,c)
            if t==xlrd.XL_CELL_DATE:
                try: v=xlrd.xldate_as_datetime(v, book.datemode).isoformat(' ')
                except Exception: pass
            vals.append(repr(v))
        print(r, '\t'.join(vals))
    # print numeric ranges and first data-looking rows
    for c in range(sh.ncols):
        nums=[]
        for r in range(sh.nrows):
            if sh.cell_type(r,c)==xlrd.XL_CELL_NUMBER:
                nums.append(sh.cell_value(r,c))
        if nums:
            print('col',c,'num count',len(nums),'min',min(nums),'max',max(nums),'first',nums[:5])
