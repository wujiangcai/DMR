import pathlib, struct, xlrd
plr=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR').read_bytes()
book=xlrd.open_workbook(r'C:\Users\caiwujiang\Documents\曲线.xls')
sh=book.sheet_by_index(0)
rows=[]
for r in range(1, min(sh.nrows, 20)):
    rows.append([int(sh.cell_value(r,c)) for c in range(2,14)])

def enc_i16(vals): return b''.join(struct.pack('<h', v) for v in vals)
def enc_i32(vals): return b''.join(struct.pack('<i', v) for v in vals)
def enc_f32(vals): return b''.join(struct.pack('<f', float(v)) for v in vals)
for name,enc in [('i16',enc_i16),('i32',enc_i32),('f32',enc_f32)]:
    print('\n',name)
    for n in [3,4,6,8,10,12]:
        pat=enc(rows[0][:n])
        idx=plr.find(pat)
        print('first row first',n,'idx',idx)
    # sequence row1+row2 all channels
    pat=enc(rows[0]+rows[1])
    print('row1+row2 idx', plr.find(pat))
# Search for sentinel encodings
for patname, pat in [('i16 -32640', struct.pack('<h', -32640)), ('u16 32896', struct.pack('<H', 32896)), ('f32 -32640', struct.pack('<f', -32640.0)), ('i32 -32640', struct.pack('<i', -32640))]:
    positions=[]; start=0
    while True:
        i=plr.find(pat,start)
        if i==-1 or len(positions)>=20: break
        positions.append(i); start=i+1
    print(patname, pat.hex(), positions[:20], 'count>=', len(positions))
# Try fixed record sizes matching first 20 rows from offsets
for rec_size in [24,26,28,32,48,52,56,64]:
  for off in range(0, min(len(plr),25000)):
    ok=True
    for ri,row in enumerate(rows[:5]):
      if plr[off+ri*rec_size:off+ri*rec_size+24]!=enc_i16(row): ok=False; break
    if ok:
      print('match i16 all 12 off',off,'rec',rec_size)
      raise SystemExit
print('no simple fixed match')
