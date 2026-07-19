import pathlib, struct, xlrd, math, statistics
plr=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR').read_bytes()
book=xlrd.open_workbook(r'C:\Users\caiwujiang\Documents\曲线.xls')
sh=book.sheet_by_index(0)
excel=[[float(sh.cell_value(r,c)) for c in range(2,14)] for r in range(1,sh.nrows)]
off=20342; rec=24
raw=[]
for i in range(len(excel)):
    raw.append([struct.unpack_from('<h',plr,off+i*rec+j*2)[0] for j in range(12)])
def corr(xs,ys):
    n=len(xs)
    if n<20: return None
    mx=sum(xs)/n; my=sum(ys)/n
    vx=sum((x-mx)**2 for x in xs); vy=sum((y-my)**2 for y in ys)
    if vx==0 or vy==0: return None
    return sum((x-mx)*(y-my) for x,y in zip(xs,ys))/math.sqrt(vx*vy)
for ec in range(12):
    best=[]
    for rc in range(12):
        xs=[]; ys=[]
        for i in range(len(excel)):
            y=excel[i][ec]
            if y == -32640: continue
            xs.append(raw[i][rc]); ys.append(y)
        c=corr(xs,ys)
        if c is not None:
            # linear fit y=a*x+b
            mx=sum(xs)/len(xs); my=sum(ys)/len(ys); vx=sum((x-mx)**2 for x in xs)
            a=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/vx if vx else 0
            b=my-a*mx
            # avg abs error rounded
            err=sum(abs((a*x+b)-y) for x,y in zip(xs,ys))/len(xs)
            best.append((abs(c),c,rc,a,b,err,min(xs),max(xs),len(xs)))
    print('Excel ch',ec+1,'best:')
    for item in sorted(best, reverse=True)[:4]: print(' ',item)
