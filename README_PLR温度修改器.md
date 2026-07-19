# PLR 温度波动修改器

这是一个用于 DMR 历史数据 `.PLR` 文件的温度曲线修改工具。

## 作用

输入：

- DMR 原始 `.PLR` 文件
- DMR 从该 `.PLR` 导出的 Excel 文件
- JSON 修改规则

输出：

- 修改后的 `.PLR` 副本
- CSV 修改报告
- JSON 修改报告

程序不会覆盖原始 `.PLR` 文件。

## 当前已验证格式

当前版本基于 `DAT0131.PLR` 样本验证：

```text
数据区起点：4214
完整记录数：3001
每条记录：24 字节
采样间隔：2 分钟
buffer_start：2023-11-05 13:30:00
1℃ ≈ 48 raw
```

已确认：

```text
通道01 -> field_01
通道02 -> field_02
通道03 -> field_03
```

默认只允许修改通道 1、2、3。需要修改其他通道时，请先完成探针验证，再加入配置中的 `valid_channels`。

## 安装依赖

需要 Python 3.10+。

读取 `.xls` 需要 `xlrd`：

```bash
python -m pip install --user xlrd
```

## 生成修改后的 PLR

在 `C:\Users\caiwujiang\Desktop\项目\DMR分析` 目录下执行：

```powershell
$env:PYTHONPATH='C:\Users\caiwujiang\Desktop\项目\DMR分析'
python -m plr_temperature_editor.main --config "C:\Users\caiwujiang\Desktop\项目\DMR分析\examples\rule.example.json"
```

运行后会生成：

```text
outputs/DAT0131_modified_test.PLR
outputs/DAT0131_modified_test_report.csv
outputs/DAT0131_modified_test_report.json
```

## 配置说明

示例配置：

```json
{
  "input": {
    "plr": "C:/path/DAT0131.PLR",
    "excel": "C:/path/曲线.xls",
    "output": "C:/path/DAT0131_modified.PLR"
  },
  "plr_format": {
    "data_offset": 4214,
    "record_size": 24,
    "total_records": 3001,
    "interval_minutes": 2,
    "buffer_start": "2023-11-05 13:30:00",
    "raw_per_celsius": 48,
    "valid_channels": [1, 2, 3]
  },
  "rules": [
    {
      "channel": 1,
      "start": "2023-11-06 15:42:00",
      "end": "2023-11-06 16:18:00",
      "mode": "absolute_clamp",
      "absolute_min": 95,
      "absolute_max": 105,
      "preserve_ranges": []
    }
  ]
}
```

## 支持模式

### `offset`

整体偏移温度。

```json
{
  "mode": "offset",
  "offset": 5
}
```

表示指定时间段整体升高约 5℃。

### `absolute_clamp`

把温度限制到绝对范围内。

```json
{
  "mode": "absolute_clamp",
  "absolute_min": 90,
  "absolute_max": 110
}
```

### `trend_clamp`

保留趋势，只压缩相对趋势线的波动。

```json
{
  "mode": "trend_clamp",
  "allowed_deviation": 3,
  "smooth_window": 5
}
```

表示温度尽量保持在趋势线 ±3℃ 内。这个模式适合处理波动过大的实际数据。

### `window_delta_clamp`

按用户设定的单位时间窗口优化曲线，让每个窗口内的最大温差不超过指定范围。

```json
{
  "mode": "window_delta_clamp",
  "window_minutes": 10,
  "max_delta": 5
}
```

表示任意连续 10 分钟窗口内，目标曲线的最高温和最低温尽量控制在 5℃ 以内。这个模式适合把局部波动过大的曲线压到指定的单位时间波动范围。

## 保留停火下降段

可以手动指定保留段：

```json
"preserve_ranges": [
  {
    "start": "2023-11-07 13:20:00",
    "end": "2023-11-07 15:00:00",
    "reason": "停火直线下降，保留"
  }
]
```

这些时间点不会被修改。

也可以让程序自动识别停火/关火造成的骤降段并保留：

```json
"auto_preserve_drop": {
  "enabled": true,
  "min_drop": 8,
  "within_minutes": 10,
  "extend_before_minutes": 0,
  "extend_after_minutes": 30,
  "reason": "自动识别停火骤降，保留原始曲线"
}
```

参数说明：

| 参数 | 说明 |
|---|---|
| `enabled` | 是否启用自动识别 |
| `min_drop` | 在判断时间内下降超过多少 ℃ 时判定为骤降 |
| `within_minutes` | 判断下降发生在多少分钟内；不填时只比较相邻的两个有效采样点 |
| `extend_before_minutes` | 识别到骤降后，向前额外保留的分钟数 |
| `extend_after_minutes` | 识别到骤降后，向后额外保留的分钟数 |
| `reason` | 报告中写入的保留原因 |

建议先使用较保守的 `min_drop`，运行后查看 `*_report.csv` 中 `skipped=True` 且 `skip_reason` 为自动保留原因的记录，再根据实际曲线调整阈值和延伸时间。命令行结束时也会输出“跳过原因统计”，可以快速确认自动保留段命中了多少个采样点。

## 对比 DMR 修改后导出的 Excel

1. 用 DMR 打开程序输出的 `.PLR`。
2. 从 DMR 导出新的 Excel，例如：

```text
C:\Users\caiwujiang\Desktop\项目\DMR分析\outputs\DAT0131_modified_test.xls
```

3. 运行对比工具：

```powershell
$env:PYTHONPATH='C:\Users\caiwujiang\Desktop\项目\DMR分析'
python -m plr_temperature_editor.compare_export ^
  --original-excel "C:\Users\caiwujiang\Documents\曲线.xls" ^
  --modified-excel "C:\Users\caiwujiang\Desktop\项目\DMR分析\outputs\DAT0131_modified_test.xls" ^
  --report-csv "C:\Users\caiwujiang\Desktop\项目\DMR分析\outputs\DAT0131_modified_test_report.csv" ^
  --channel 1 ^
  --start "2023-11-06 15:42:00" ^
  --end "2023-11-06 16:18:00" ^
  --tolerance 1 ^
  --output "C:\Users\caiwujiang\Desktop\项目\DMR分析\outputs\DAT0131_modified_test_compare.csv"
```

对比报告中的 `status`：

```text
ok                修改后温度与预期目标在容差内；保留段会用原始温度作为预期目标
mismatch          修改后温度与预期目标不一致
no_expected       没有传入修改报告或该点没有目标值
missing_modified  修改后 Excel 中没有该温度值
```

对比 CSV 也会输出 `skipped` 和 `skip_reason`，用于确认停火/关火保留段在 DMR 导出后仍保持原始曲线。

## 注意事项

- 不要覆盖原始 `.PLR`。
- 不建议修改有效数据边界附近。
- 不建议修改 `field_00`、`field_10`、`field_11`。
- 修改后的 `.PLR` 应标记为模拟/修改后数据，不应用作真实审计记录。
