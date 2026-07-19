import pathlib, struct, xlrd, statistics, math
plr=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR').read_bytes()
book=xlrd.open_workbook(r'C:\Users\caiwujiang\Documents\曲线.xls')
sh=book.sheet_by_index(0)
rows=[[sh.cell_value(r,c) for c in range(2,14)] for r in range(1,sh.nrows)]
print('rows',len(rows),'size',len(plr),'size-rows*24',len(plr)-len(rows)*24,'size-rows*12',len(plr)-len(rows)*12)
for off in [len(plr)-len(rows)*24, len(plr)-len(rows)*12, 20000, 20342, 160*127, 75200-24*10]:
 print('\nOFF',off)
 for i in range(5):
  chunk=plr[off+i*24:off+(i+1)*24]
  print(i, 'hex', chunk.hex(' '), 'i16', [struct.unpack_from('<h',chunk,j)[0] for j in range(0,len(chunk)-1,2)])
# brute correlation for possible off and rec size: bytes/u16 at channel positions correlate with values (excluding -32640)
def corr(a,b):
 n=len(a)
 if n<10: return 0
 ma=sum(a)/n; mb=sum(b)/n
 va=sum((x-ma)**2 for x in a); vb=sum((y-mb)**2 for y in b)
 if va==0 or vb==0: return 0
 return sum((x-ma)*(y-mb) for x,y in zip(a,b))/math.sqrt(va*vb)
for rec in [12,24,36,48,56,64]:
 best=[]
 maxoff=len(plr)-rec*len(rows)
 if maxoff<0: continue
 for off in range(max(0,maxoff-5000), min(len(plr)-rec*min(1000,len(rows)), maxoff+5000)):
  # test first channel at byte position variants
  for pos in range(0,min(rec,32)):
   a=[]; b=[]
   for i,row in enumerate(rows[:500]):
    val=row[0]
    if val==-32640: continue
    idx=off+i*rec+pos
    if idx>=len(plr): break
    a.append(plr[idx]); b.append(val)
   c=abs(corr(a,b))
   if c>0.6: best.append((c,off,pos,'u8'))
   if pos+1<rec:
    a=[]; b=[]
    for i,row in enumerate(rows[:500]):
     val=row[0]
     if val==-32640: continue
     idx=off+i*rec+pos
     if idx+2>len(plr): break
     a.append(struct.unpack_from('<h',plr,idx)[0]); b.append(val)
    c=abs(corr(a,b))
    if c>0.6: best.append((c,off,pos,'i16'))
 best=sorted(best, reverse=True)[:10]
 print('rec',rec,'best',best)
