# DMR / PLR 文件分析与温度波动修改程序开发计划

> 记录时间：2026-07-03  
> 目标：在保留原始 `.PLR` 文件的前提下，生成一个修改后的 `.PLR` 副本，使 DMR 导入后显示用户设定范围内的温度波动曲线。

---

## 1. 背景与目标

当前使用的是杭州盘古 DMR 上位机软件，原始数据文件来自 U 盘导出：

```text
C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR
```

DMR 可以导入 `.PLR` 文件并导出 Excel，但软件本身不能编辑 `.PLR` 中的温度数据。

最终目标是开发一个程序：

```text
输入：原始 PLR 文件 + 用户设定的波动要求
输出：新的 PLR 文件
效果：DMR 导入新 PLR 后，指定通道、指定时间段内的温度曲线符合用户设定的波动范围
```

注意：程序应始终生成副本，不覆盖原始文件。

---

## 2. 官网与软件环境分析结论

### 2.1 官网资源

官网页面：

```text
http://www.pangu.com.cn/product-item-23.html
```

对应产品：

```text
VX5300R 系列蓝屏记录仪
```

官网公开资源包括：

- DMR 上位机安装包
- VX5300 说明书
- VX5300 产品样册

没有发现公开的：

- 源码
- SDK
- API 文档
- 二次开发包
- 插件开发文档

### 2.2 软件安装目录

DMR 安装目录：

```text
C:\Program Files (x86)\DMR\dmr\
```

主要文件：

```text
DMEngine.exe
ModbusRLib.dll
Analyzer\
IO_Device\
Data\
Language\
HelpCN.chm
HelpEN.chm
HelpCT.chm
```

`Analyzer` 目录包含：

```text
ArfAnalyzer.dll
DatAnalyzer.dll
GrfAnalyzer.dll
MCAnalyzer.dll
```

这些 DLL 导出函数包括：

```text
GetDevice
GetDocString
GetFilter
GetRegisterInfo
```

说明 DMR 内部有文件解析插件机制，但没有公开接口文档。

### 2.3 Modbus 通信结论

VX5300 说明书确认设备支持：

```text
RS232C / RS485
MODBUS-RTU
OPC 驱动
USB U盘备份
```

但本次目标不是实时采集设备，而是修改 `.PLR` 历史文件，所以重点放在 PLR 文件结构分析。

---

## 3. 原始 PLR 与 Excel 基本信息

### 3.1 原始 PLR 文件

原始文件：

```text
C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR
```

文件大小：

```text
76238 字节
```

文件头前 16 字节可见：

```text
MCA63R1041SX400
```

SHA256：

```text
596576cd37f239852fa084f289b2c328f4bafb25c78d25825c50a3a3345a2744
```

文件不是普通文本，也不是 Excel/CSV。它是二进制结构化文件，包含设备信息、通道信息、记录数据等。

### 3.2 DMR 导出的原始 Excel

DMR 导出的 Excel：

```text
C:\Users\caiwujiang\Documents\曲线.xls
```

表结构：

```text
编号
时间
通道01(℃)
通道02(℃)
通道03(℃)
通道04(℃)
通道05(℃)
通道06(℃)
通道07(℃)
通道08(℃)
通道09(℃)
通道10(℃)
通道11(℃)
通道12(℃)
```

原始导出数据：

```text
记录数：2329 行
起始时间：2023/11/06 10:00:00
结束时间：2023/11/09 15:36:00
采样间隔：2 分钟
通道数：12
```

示例第一行：

```text
2023/11/06 10:00:00
通道01：20
通道02：21
通道03：-32640
通道04：20
通道05：20
通道06：19
通道07：20
通道08：20
通道09：20
通道10：19
通道11：-32640
通道12：-32640
```

`-32640` 是 DMR 导出的特殊值，可能代表断线、无效、空值或异常值。

---

## 4. PLR 文件结构推断

### 4.1 初始误判与修正

一开始根据：

```text
2329 行 × 12 通道 × 2 字节 = 55896 字节
76238 - 55896 = 20342 字节
```

曾推测：

```text
20342 是数据区起点
```

但探针测试证明，`20342` 附近是有效数据边界附近，直接修改会影响 DMR 对有效数据范围的判断。

进一步分析发现，DMR 在探针文件中可以导出：

```text
3001 行
2023/11/05 13:30:00 到 2023/11/09 17:30:00
```

因此更合理的结构是：

```text
文件总大小：76238 字节
完整环形缓冲记录数：3001 条
每条记录大小：24 字节
完整数据区大小：3001 × 24 = 72024 字节
头部/配置区大小：76238 - 72024 = 4214 字节
```

### 4.2 当前推断结构

```text
0 - 4213 字节：文件头、设备信息、通道配置、索引/状态信息
4214 - 76237 字节：完整 3001 条环形缓冲记录
```

其中：

```text
每条记录 = 24 字节
每条记录 = 12 个 int16 字段
```

记录偏移计算公式：

```text
record_offset = 4214 + record_index * 24
field_offset  = record_offset + field_index * 2
```

其中 `record_index` 是完整 3001 条环形缓冲区中的 0 基下标。

### 4.3 有效导出数据范围

原始 DMR 导出只显示 2329 行，从：

```text
2023/11/06 10:00:00
```

开始。

在完整 3001 条缓冲区中，这对应大约第 615 条或第 616 条附近，具体原因与 DMR 的边界/索引处理有关。

已知探针结果中：

```text
Excel row 616 对应 2023/11/06 10:00:00
Excel row 787 对应 2023/11/06 15:42:00
```

在程序中可以用时间换算定位：

```text
完整缓冲起始时间：2023/11/05 13:30:00
采样间隔：2 分钟
record_index = (目标时间 - 2023/11/05 13:30:00) / 2分钟
```

示例：

```text
2023/11/06 15:42:00 对应完整缓冲区第 786 条附近，0 基 record_index = 786
```

注意：DMR 导出的 Excel 编号是 1 基编号，程序中使用 0 基 record_index。

---

## 5. 字段到通道的映射

通过 `rec0700_20rows_field_xx_wave` 探针已经确认：

| PLR field_index | DMR/Excel 通道 |
|---:|---|
| `field_01` | `通道01(℃)` |
| `field_02` | `通道02(℃)` |
| `field_03` | `通道03(℃)` |

大概率：

| PLR field_index | DMR/Excel 通道 |
|---:|---|
| `field_04` | `通道04(℃)` |
| `field_05` | `通道05(℃)` |
| `field_06` | `通道06(℃)` |
| `field_07` | `通道07(℃)` |
| `field_08` | `通道08(℃)` |
| `field_09` | `通道09(℃)` |

不建议修改：

```text
field_00
field_10
field_11
```

原因：这些字段在探针中表现为 0 或边界/状态影响明显，可能不是普通温度通道数据。

### 通道号到 field_index 的映射

对于目前可控温度通道，可使用：

```text
field_index = channel_number
```

例如：

```text
通道01 -> field_index 1
通道02 -> field_index 2
通道03 -> field_index 3
```

即通道号从 1 开始时，刚好等于 field_index。

---

## 6. 探针测试结果汇总

### 6.1 第一批探针

目录：

```text
C:\Users\caiwujiang\Desktop\项目\DMR分析\probes
```

包含：

```text
DAT0131_probe_first_field_00_to_30000.PLR
DAT0131_probe_first_field_01_to_30000.PLR
DAT0131_probe_first_field_02_to_30000.PLR
DAT0131_probe_first_field_03_to_30000.PLR
...
DAT0131_probe_first_record_step_values.PLR
DAT0131_probe_field_00_first_10_rows_ramp.PLR
```

测试结论：

- 直接修改 `20342` 附近的字段会导致 DMR 导出行数、起止时间发生变化。
- `field_00` 明显不是普通温度值字段。
- `field_01`、`field_02`、`field_03` 在边界位置修改也会影响有效范围判断。

### 6.2 第二批探针

目录：

```text
C:\Users\caiwujiang\Desktop\项目\DMR分析\probes2
```

选择完整缓冲区中更安全的位置：

```text
数据区起点：4214
测试记录：第 700 条附近
测试偏移：21014
```

代表文件：

```text
DAT0131_probe_rec0700_20rows_field_01_wave.PLR
DAT0131_probe_rec0700_20rows_field_02_wave.PLR
DAT0131_probe_rec0700_20rows_field_03_wave.PLR
```

导出 Excel 后确认：

```text
field_01_wave 只影响通道01
field_02_wave 只影响通道02
field_03_wave 只影响通道03
```

实际影响时间段：

```text
2023/11/06 15:42:00 到 2023/11/06 16:18:00
```

实际变化示例：

```text
field_01 -> 通道01：
2023/11/06 15:42:00  89  -> 98   +9
2023/11/06 15:44:00  90  -> 107  +17
2023/11/06 15:46:00  91  -> 116  +25
2023/11/06 15:48:00  93  -> 126  +33
```

---

## 7. 原始值与温度值换算关系

探针中写入的原始值变化为：

```text
0
+400
+800
+1200
+1600
循环
```

DMR 导出的温度变化约为：

```text
0℃
+8 到 +9℃
+16 到 +17℃
+25 到 +26℃
+33 到 +34℃
```

因此可暂定换算关系：

```text
温度变化 ≈ 原始值变化 / 48
原始值变化 ≈ 温度变化 × 48
```

示例：

```text
目标升高 10℃ -> 原始值增加约 480
目标降低 5℃  -> 原始值减少约 240
目标增加 ±3℃ 波动 -> 原始值增加约 ±144
```

这是当前程序实现的核心换算依据。

后续如果需要更精确，可用更多探针或 Excel 对照拟合每个通道的比例系数。

---

## 8. 程序开发目标

### 8.1 程序名称建议

```text
plr_temperature_editor.py
```

或做成桌面工具：

```text
PLR 温度波动修改器
```

### 8.2 初版功能目标

程序能够：

1. 读取原始 `.PLR` 文件。
2. 根据用户设定定位目标通道和时间段。
3. 在指定时间段内修改对应通道的原始值。
4. 生成新的 `.PLR` 文件副本。
5. 输出修改日志，说明改了哪些时间点、通道、原始值变化和预期温度变化。

### 8.3 输入参数

建议初版支持命令行参数：

```bash
python plr_temperature_editor.py ^
  --input DAT0131.PLR ^
  --output DAT0131_modified.PLR ^
  --channel 1 ^
  --start "2023-11-06 15:42:00" ^
  --end "2023-11-06 16:18:00" ^
  --mode sine ^
  --amplitude 5
```

参数说明：

| 参数 | 说明 |
|---|---|
| `--input` | 原始 PLR 文件 |
| `--output` | 输出 PLR 文件 |
| `--channel` | DMR 通道号，1 表示通道01 |
| `--start` | 修改起始时间 |
| `--end` | 修改结束时间 |
| `--mode` | 修改模式 |
| `--amplitude` | 波动幅度，单位 ℃ |
| `--offset` | 整体偏移，单位 ℃ |
| `--min` | 目标温度下限 |
| `--max` | 目标温度上限 |
| `--seed` | 随机模式种子，可复现 |

---

## 9. 修改模式设计

### 9.1 模式 A：整体偏移 offset

用途：让某段温度整体升高或降低。

示例：

```text
通道01 2023/11/06 15:42:00 - 16:18:00 整体 +5℃
```

原始值修改：

```text
raw_new = raw_old + round(offset_celsius * 48)
```

### 9.2 模式 B：正弦波动 sine

用途：在原曲线基础上增加平滑上下波动。

示例：

```text
通道01 指定时间段增加 ±5℃ 正弦波动
```

公式：

```text
delta_temp = amplitude * sin(2π * i / period)
raw_new = raw_old + round(delta_temp * 48)
```

其中：

```text
i = 当前点在目标区间内的序号
period = 一个周期包含的数据点数量
```

### 9.3 模式 C：随机波动 random-range

用途：让温度落在用户设定的波动范围内。

示例：

```text
让通道01 在 95℃ 到 105℃ 之间波动
```

如果只做相对修改：

```text
delta_temp = random.uniform(-amplitude, +amplitude)
raw_new = raw_old + round(delta_temp * 48)
```

如果做目标范围约束：

```text
预估当前温度 current_temp 从 Excel 或解析器获得
目标温度 target_temp = random.uniform(min_temp, max_temp)
delta_temp = target_temp - current_temp
raw_new = raw_old + round(delta_temp * 48)
```

注意：如果程序不读取 Excel，就无法准确知道当前显示温度，只能做相对波动。若要严格控制到 `[min, max]`，建议输入 DMR 导出的原始 Excel 做对照。

### 9.4 模式 D：线性变化 linear

用途：让温度从某值线性过渡到某值。

示例：

```text
通道02 从 90℃ 线性升到 130℃
```

如果已知当前显示温度，可计算：

```text
target_temp_i = start_temp + (end_temp - start_temp) * i / (n - 1)
delta_temp_i = target_temp_i - current_temp_i
raw_new = raw_old + round(delta_temp_i * 48)
```

---

## 10. 时间到记录位置的定位

### 10.1 当前样本固定参数

```text
完整缓冲起始时间：2023/11/05 13:30:00
采样间隔：2 分钟
数据区起点：4214
记录大小：24 字节
总记录数：3001
```

记录定位公式：

```text
record_index = int((target_time - buffer_start_time) / interval)
record_offset = 4214 + record_index * 24
field_offset = record_offset + channel * 2
```

当前映射中：

```text
channel 1 -> field_offset = record_offset + 1 * 2
channel 2 -> field_offset = record_offset + 2 * 2
channel 3 -> field_offset = record_offset + 3 * 2
```

### 10.2 后续泛化问题

当前 `buffer_start_time = 2023/11/05 13:30:00` 是从探针导出结果中确认的。不同 PLR 文件可能不同。

初版程序可以先要求用户提供：

```text
--buffer-start "2023-11-05 13:30:00"
--interval-minutes 2
```

或者要求同时输入 DMR 导出的 Excel，通过 Excel 第一行时间和行号反推有效时间。

更高级版本再尝试从 PLR 头部或记录区自动解析起始时间。

---

## 11. 实现路线计划

### 阶段 1：命令行原型

目标：先实现可用脚本，能改指定通道、指定时间段的相对波动。

步骤：

1. 读取 PLR 为 `bytearray`。
2. 校验文件大小是否符合当前样本结构：
   
   ```text
   file_size == 76238
   data_offset == 4214
   record_size == 24
   total_records == 3001
   ```

3. 解析用户参数：通道、开始时间、结束时间、模式、幅度。
4. 计算记录下标范围。
5. 对每条记录读取原始 `int16`。
6. 根据模式计算 `delta_raw`。
7. 写回 `int16`。
8. 保存新 PLR。
9. 输出修改日志 CSV/JSON。

### 阶段 2：与 Excel 对照

目标：实现严格按目标温度范围修改。

输入增加：

```text
--excel C:\Users\caiwujiang\Documents\曲线.xls
--min-temp 95
--max-temp 105
```

步骤：

1. 读取 DMR 导出的 Excel。
2. 根据时间和通道获取当前显示温度。
3. 生成目标温度。
4. 计算：

   ```text
   delta_temp = target_temp - current_temp
   delta_raw = round(delta_temp * 48)
   ```

5. 写回 PLR。
6. 输出对照日志：

   ```text
   时间, 通道, 原温度, 目标温度, 原raw, 新raw, delta_raw
   ```

### 阶段 3：图形界面

可选技术：

```text
Python + PySide6
```

界面功能：

- 选择 PLR 文件
- 选择原始 Excel 文件
- 设置通道
- 设置时间段
- 设置波动范围
- 预览目标曲线
- 生成修改后 PLR
- 导出修改日志

---

## 12. 初版脚本伪代码

```python
from pathlib import Path
from datetime import datetime, timedelta
import struct
import math

DATA_OFFSET = 4214
RECORD_SIZE = 24
TOTAL_RECORDS = 3001
RAW_PER_CELSIUS = 48

BUFFER_START = datetime(2023, 11, 5, 13, 30, 0)
INTERVAL = timedelta(minutes=2)


def time_to_record_index(t: datetime) -> int:
    delta = t - BUFFER_START
    return int(delta.total_seconds() // INTERVAL.total_seconds())


def read_i16(buf: bytearray, record_index: int, field_index: int) -> int:
    offset = DATA_OFFSET + record_index * RECORD_SIZE + field_index * 2
    return struct.unpack_from('<h', buf, offset)[0]


def write_i16(buf: bytearray, record_index: int, field_index: int, value: int):
    value = max(-32768, min(32767, value))
    offset = DATA_OFFSET + record_index * RECORD_SIZE + field_index * 2
    struct.pack_into('<h', buf, offset, value)


def apply_sine(buf, channel, start, end, amplitude, period_points=10):
    field_index = channel
    start_i = time_to_record_index(start)
    end_i = time_to_record_index(end)
    for n, record_index in enumerate(range(start_i, end_i + 1)):
        raw_old = read_i16(buf, record_index, field_index)
        delta_temp = amplitude * math.sin(2 * math.pi * n / period_points)
        raw_new = raw_old + round(delta_temp * RAW_PER_CELSIUS)
        write_i16(buf, record_index, field_index, raw_new)
```

---

## 13. 风险与注意事项

### 13.1 不覆盖原文件

必须永远生成副本：

```text
DAT0131_modified.PLR
```

不要覆盖：

```text
DAT0131.PLR
```

### 13.2 不修改边界附近

之前测试证明边界附近修改会影响 DMR 导出的有效范围。

初版建议避免修改：

```text
2023/11/06 10:00:00 附近
2023/11/09 15:36:00 附近
```

优先修改中间稳定区间。

### 13.3 不修改特殊字段

不建议修改：

```text
field_00
field_10
field_11
```

### 13.4 int16 范围限制

写入值必须限制在：

```text
-32768 到 32767
```

### 13.5 数据真实性问题

`.PLR` 是工业记录仪历史数据文件，修改后应标记为模拟/修改后文件，不应用作真实审计数据。

---

## 14. 下一步建议

### 14.1 先做命令行脚本

优先实现：

```text
模式：relative-wave
功能：在原曲线基础上增加指定幅度波动
```

例如：

```bash
python plr_temperature_editor.py ^
  --input "C:\Users\caiwujiang\Documents\xwechat_files\wxid_eowf0xmbz0tr22_e9a1\msg\file\2026-07\DAT0131.PLR" ^
  --output "C:\Users\caiwujiang\Desktop\项目\DMR分析\DAT0131_modified_ch1_wave.PLR" ^
  --channel 1 ^
  --buffer-start "2023-11-05 13:30:00" ^
  --start "2023-11-06 15:42:00" ^
  --end "2023-11-06 16:18:00" ^
  --mode sine ^
  --amplitude 5 ^
  --period-points 10
```

### 14.2 再做 Excel 对照版

如果要求“温度必须落在设定范围内”，则建议输入原始 Excel：

```bash
python plr_temperature_editor.py ^
  --input DAT0131.PLR ^
  --excel 曲线.xls ^
  --output DAT0131_modified.PLR ^
  --channel 1 ^
  --start "2023-11-06 15:42:00" ^
  --end "2023-11-06 16:18:00" ^
  --mode clamp-random ^
  --min-temp 95 ^
  --max-temp 105
```

该模式需要读取 Excel 当前温度，然后反算 PLR 原始值修改量。

---

## 15. 当前已确认事实摘要

1. `.PLR` 文件可被修改后继续由 DMR 读取。
2. 文件不是加密文件。
3. 文件大小为 76238 字节。
4. 当前样本完整数据区起点为 4214。
5. 当前样本完整记录数为 3001。
6. 每条记录 24 字节。
7. 每条记录可看作 12 个 int16 字段。
8. `field_01` 对应 `通道01(℃)`。
9. `field_02` 对应 `通道02(℃)`。
10. `field_03` 对应 `通道03(℃)`。
11. 温度变化与原始值变化比例约为 `1℃ ≈ 48 raw`。
12. 可通过修改对应字段制造 DMR 中可见的温度波动。
13. 边界附近修改会影响 DMR 的有效导出范围，正式程序应避开或谨慎处理。
14. 若要严格修改到指定温度范围，建议结合 DMR 导出的 Excel 做当前温度对照。
