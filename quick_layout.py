import pathlib, struct, xlrd, math
plr=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR').read_bytes()
book=xlrd.open_workbook(r'C:\Users\caiwujiang\Documents\曲线.xls')
sh=book.sheet_by_index(0)
rows=[[int(sh.cell_value(r,c)) for c in range(2,14)] for r in range(1,sh.nrows)]
print('rows',len(rows),'size',len(plr),'header if 24/row',len(plr)-len(rows)*24,'header if 12/row',len(plr)-len(rows)*12)
for off in [0, 1857, 20342, 20480, 75200-240, 75200, len(plr)-len(rows)*24, len(plr)-len(rows)*12]:
 print('\nOFF',off)
 for i in range(3):
  chunk=plr[off+i*24:off+(i+1)*24]
  print(i, 'i16', [struct.unpack_from('<h',chunk,j)[0] for j in range(0,len(chunk)-1,2)], 'hex', chunk.hex(' '))
print('\nExcel first 3')
for r in rows[:3]: print(r)
# Try transformations: raw maybe value*10, value+offset, invalid as special absent. Search row1 individual values within expected data region.
region_start=max(0,len(plr)-len(rows)*24-4096)
region=plr[region_start:]
for v in [20,21,19,264,1284,1372,-32640]:
 print('\nvalue',v)
 pats=[]
 for name,b in [('i16',struct.pack('<h',v) if -32768<=v<=32767 else b''),('i16x10',struct.pack('<h',v*10) if -3277<=v<=3276 else b''),('u16',struct.pack('<H',v) if 0<=v<=65535 else b''),('f32',struct.pack('<f',float(v)) )]:
  if not b: continue
  pos=[]; start=0
  while len(pos)<10:
   idx=region.find(b,start)
   if idx<0: break
   pos.append(region_start+idx); start=idx+1
  print(name,b.hex(),pos)
