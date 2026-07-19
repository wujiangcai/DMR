import pathlib, struct, datetime
plr=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR').read_bytes()
dt=datetime.datetime(2023,11,6,10,0,0)
ts=int(dt.timestamp())
print('unix',ts, hex(ts), struct.pack('<I',ts).hex(), 'idx', plr.find(struct.pack('<I',ts)))
# windows filetime
ft=int((dt-datetime.datetime(1601,1,1)).total_seconds()*10_000_000)
for fmt,val,n in [('filetime',ft,8),('excel days',45236.4166666667,8)]:
    if fmt=='filetime': b=struct.pack('<Q',val)
    else: b=struct.pack('<d',val)
    print(fmt, b.hex(), plr.find(b))
# BCD patterns YY MM DD hh mm ss and full
patterns=[bytes([0x23,0x11,0x06,0x10,0x00,0x00]), bytes([0x20,0x23,0x11,0x06,0x10,0x00,0x00]), bytes([23,11,6,10,0,0]), bytes([2023%256,2023//256,11,6,10,0,0])]
for b in patterns: print('pat',b.hex(),plr.find(b))
# intervals of possible timestamps every 120 sec, search any 10 sequence with rec sizes
seq=[ts+i*120 for i in range(10)]
for rec in [4,8,24,28,32,40,48,56,64,80]:
 for off in range(len(plr)-rec*9-4):
  ok=True
  for i,v in enumerate(seq):
   if plr[off+i*rec:off+i*rec+4]!=struct.pack('<I',v): ok=False; break
  if ok: print('unix seq off',off,'rec',rec); raise SystemExit
print('no unix seq')
