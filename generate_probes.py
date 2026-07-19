from pathlib import Path
import struct, json, hashlib
src = Path(r'C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR')
out = Path(r'C:\Users\caiwujiang\Desktop\项目\DMR分析\probes')
data = bytearray(src.read_bytes())
record_count = 2329
channel_count = 12
record_size = 24
data_offset = len(data) - record_count * record_size
assert data_offset == 20342, data_offset
original_first = [struct.unpack_from('<h', data, data_offset + i * 2)[0] for i in range(channel_count)]
manifest = {
    'source': str(src),
    'source_sha256': hashlib.sha256(data).hexdigest(),
    'data_offset': data_offset,
    'record_size': record_size,
    'record_count': record_count,
    'channel_count': channel_count,
    'original_first_record_i16': original_first,
    'files': []
}
# 第一组：只改第1条记录的一个字段，值设成明显但不过大的正数
for field in range(channel_count):
    buf = bytearray(data)
    patch_offset = data_offset + field * 2
    new_value = 30000
    struct.pack_into('<h', buf, patch_offset, new_value)
    name = f'DAT0131_probe_first_field_{field:02d}_to_{new_value}.PLR'
    path = out / name
    path.write_bytes(buf)
    manifest['files'].append({
        'name': name,
        'type': 'first-record-single-field',
        'field_index_zero_based': field,
        'patch_offset': patch_offset,
        'old_i16': original_first[field],
        'new_i16': new_value,
        'sha256': hashlib.sha256(buf).hexdigest()
    })
# 第二组：在疑似第1条记录全部12字段写入阶梯值，便于看 DMR 是否接受整行修改
buf = bytearray(data)
step_values = [1000, 3000, 5000, 7000, 9000, 11000, 13000, 15000, 17000, 19000, 21000, 23000]
for field, val in enumerate(step_values):
    struct.pack_into('<h', buf, data_offset + field * 2, val)
name = 'DAT0131_probe_first_record_step_values.PLR'
path = out / name
path.write_bytes(buf)
manifest['files'].append({
    'name': name,
    'type': 'first-record-all-fields-step',
    'patch_offset_start': data_offset,
    'old_i16': original_first,
    'new_i16': step_values,
    'sha256': hashlib.sha256(buf).hexdigest()
})
# 第三组：连续10条记录的第1字段写成明显斜坡，便于看曲线是否变形
buf = bytearray(data)
ramp_values = [1000 + i * 3000 for i in range(10)]
for row, val in enumerate(ramp_values):
    struct.pack_into('<h', buf, data_offset + row * record_size + 0 * 2, val)
name = 'DAT0131_probe_field_00_first_10_rows_ramp.PLR'
path = out / name
path.write_bytes(buf)
manifest['files'].append({
    'name': name,
    'type': 'field-00-first-10-rows-ramp',
    'field_index_zero_based': 0,
    'row_count': 10,
    'new_i16': ramp_values,
    'sha256': hashlib.sha256(buf).hexdigest()
})
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print('output_dir=', out)
print('data_offset=', data_offset)
print('original_first_record_i16=', original_first)
print('created_files=', len(manifest['files']))
for item in manifest['files']:
    print(item['name'])
