import pathlib, re, struct, collections
p=pathlib.Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR')
data=p.read_bytes()
print('size', len(data))
print('entropy sample unique bytes', len(set(data[:4096])))
print('nul count', data.count(0), 'ff count', data.count(255))
# ASCII strings
ss=re.findall(rb'[ -~]{4,}', data)
print('ascii strings count', len(ss))
for s in ss[:80]: print('ASCII', s[:120].decode('latin1','ignore'))
# UTF-16LE likely strings
u=[]
for m in re.finditer(rb'(?:[ -~]\x00){4,}', data):
    try: u.append(m.group().decode('utf-16le'))
    except: pass
print('utf16 strings count', len(u))
for s in u[:80]: print('UTF16', s[:120])
# common timestamps around 2000-2035 unix little endian
hits=[]
for off in range(0, min(len(data)-4, 200000), 1):
    v=struct.unpack_from('<I',data,off)[0]
    if 946684800 <= v <= 2051222400:
        hits.append((off,v))
        if len(hits)>=30: break
print('unix time hits', hits[:30])
# repeated 4-byte headers first 256 bytes as ints
print('first u32 le', [struct.unpack_from('<I',data,i)[0] for i in range(0,min(64,len(data)-3),4)])
