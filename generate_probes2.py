from pathlib import Path
import struct, json, hashlib
src = Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR')
out = Path(r'C:\Users\caiwujiang\Desktop\项目\DMR分析\probes2')
data = bytearray(src.read_bytes())
file_size = len(data)
storage_records = 3001
record_size = 24
data_offset = file_size - storage_records * record_size
# 原始导出从全量第616条附近开始；选全量第700条，避开边界
probe_record_index = 700  # zero-based in full 3001-record storage
record_offset = data_offset + probe_record_index * record_size
original_record = [struct.unpack_from('<h', data, record_offset + i*2)[0] for i in range(12)]
manifest = {
  'source': str(src),
  'source_sha256': hashlib.sha256(data).hexdigest(),
  'file_size': file_size,
  'storage_records': storage_records,
  'record_size': record_size,
  'data_offset': data_offset,
  'probe_record_index_zero_based': probe_record_index,
  'probe_record_offset': record_offset,
  'original_probe_record_i16': original_record,
  'note': 'These probes modify one non-boundary record in the inferred 3001-record storage area.',
  'files': []
}
# 单字段：只把第700条某字段增加/改成较明显但不破坏索引的值。避免 30000 这种极端值，先用 +1000 和 12000。
for field in range(12):
    for mode, new_value in [('to_12000', 12000), ('plus_1000', max(-32768, min(32767, original_record[field] + 1000)) )]:
        buf = bytearray(data)
        patch_offset = record_offset + field*2
        struct.pack_into('<h', buf, patch_offset, new_value)
        name = f'DAT0131_probe_rec0700_field_{field:02d}_{mode}.PLR'
        path = out / name
        path.write_bytes(buf)
        manifest['files'].append({
            'name': name,
            'record_index_zero_based': probe_record_index,
            'field_index_zero_based': field,
            'patch_offset': patch_offset,
            'old_i16': original_record[field],
            'new_i16': new_value,
            'sha256': hashlib.sha256(buf).hexdigest()
        })
# 曲线波动探针：对第700-719条的字段1/2/3分别做小幅正弦/阶梯，看看哪个通道变化
for field in [1,2,3,4,5,6,7,8,9]:
    buf = bytearray(data)
    vals=[]
    for i in range(20):
        off = data_offset + (probe_record_index+i)*record_size + field*2
        old = struct.unpack_from('<h', data, off)[0]
        delta = (i % 5) * 400
        new = max(-32768, min(32767, old + delta))
        struct.pack_into('<h', buf, off, new)
        vals.append({'row': probe_record_index+i, 'old': old, 'new': new})
    name = f'DAT0131_probe_rec0700_20rows_field_{field:02d}_wave.PLR'
    path = out / name
    path.write_bytes(buf)
    manifest['files'].append({
        'name': name,
        'type': '20-row-wave',
        'field_index_zero_based': field,
        'start_record_index_zero_based': probe_record_index,
        'values': vals,
        'sha256': hashlib.sha256(buf).hexdigest()
    })
(out/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print('output_dir=', out)
print('file_size=', file_size)
print('data_offset=', data_offset)
print('probe_record_offset=', record_offset)
print('original_probe_record_i16=', original_record)
print('created_files=', len(manifest['files']))
for item in manifest['files'][:40]: print(item['name'])
