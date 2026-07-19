import pathlib, struct
p=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR')
data=p.read_bytes()
for off in [0,16,32,64,96,128,160,176,192,320,480,640,75200]:
    print('\nOFF',off)
    chunk=data[off:off+96]
    print('hex', ' '.join(f'{b:02X}' for b in chunk))
    print('u16', [struct.unpack_from('<H', chunk, i)[0] for i in range(0, min(len(chunk)-1,32),2)])
    print('i16', [struct.unpack_from('<h', chunk, i)[0] for i in range(0, min(len(chunk)-1,32),2)])
    vals=[]
    for i in range(0,min(len(chunk)-3,32),4):
      vals.append(round(struct.unpack_from('<f', chunk, i)[0],4))
    print('f32', vals)
