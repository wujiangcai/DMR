# DMR 3.20.0 端到端验收记录

验收日期：2026-07-18～2026-07-19  
验收对象：DMR Curve Studio 0.1.0  
DMR 主程序：`C:\Program Files (x86)\DMR\dmr\DMEngine.exe`  
DMR 版本：3.20.0 / x86

## 1. 验收用例

在真实 `DAT0131.PLR` 中，只编辑一个明确时间点：

```text
时间：2023-11-06 10:00:00
通道：通道01
原始温度：20℃
目标温度：25℃
Excel 首行物理记录：530
原 raw：963
新 raw：1203
delta_raw：(25 - 20) × 48 = 240
```

## 2. Curve Studio 导出前校验

```text
原文件长度：76238 字节
输出文件长度：76238 字节
变化字节偏移：16936、16937
计划字段偏移：4214 + 530 × 24 + 1 × 2 = 16936
头部变化：0 字节
非目标变化：0 字节
```

## 3. DMR 实际打开

操作：

```text
DMEngine.exe C:\tmp\dmr-test\DAT0131-edited.PLR
```

实际结果：

- DMR 主窗口标题：`DMR - [DAT0131-edited]`；
- DMR 成功加载 `MCAnalyzer.dll`；
- DMR 根据文件签名成功加载 `A63R104.dll` 设备插件；
- 曲线窗口正常显示；
- 文件没有报损坏或格式错误。

界面证据：

```text
fixtures/e2e/DMR_opened_edited_PLR.png
```

## 4. DMR 实际 Excel 回读

在 DMR 中执行：

```text
文件 -> Excel导出
```

DMR 生成：

```text
fixtures/e2e/DAT0131_one_point_25C_DMR_export.xls
```

回读结果：

```text
2023/11/06 10:00:00  通道01 = 25℃
2023/11/06 10:02:00  通道01 = 20℃（未修改，保持）
2023/11/06 15:42:00  通道01 = 89℃（未修改，保持）
```

将原始 Excel 的全部有效通道点与 DMR 新导出 Excel 对比：

```text
计划修改的有效点：1
计划修改命中：1
其他有效点差异：0
缺失时间行：0
```

Curve Studio 应用内回读验证截图：

```text
fixtures/e2e/Curve_Studio_DMR_Verification.png
```

原始 Excel 中的 `-32640` 断线/无效值在 DMR 对完整环形缓冲导出时会显示为 `0`；这些点不属于可编辑有效温度，验证器会跳过。所有原本有效的温度点中，只有计划的一个点发生变化。

## 5. 环形范围现象

原始用户 Excel：

```text
2330 行（含表头）
2023/11/06 10:00:00 ～ 2023/11/09 15:36:00
```

DMR 对编辑后 PLR 导出的 Excel：

```text
3002 行（含表头）
2023/11/05 13:30:00 ～ 2023/11/09 17:30:00
```

这与旧项目中已出现的现象一致：DMR 打开文件副本后按完整 3001 条环形缓冲区导出。PLR 头部并未变化；有效温度区间的数据仍按时间正确对应。Curve Studio 的回读验证按时间连接并忽略原始无效点，因此不会把扩展出来的缓冲行误判为温度修改。

## 6. 回归文件哈希

```text
fixtures/DAT0131.PLR
SHA256 596576CD37F239852FA084F289B2C328F4BAFB25C78D25825C50A3A3345A2744

fixtures/curve.xls
SHA256 B75B322743CBF64B75931AFD84AE9466B6C816C205A0739382E6E36F93F90C10

fixtures/e2e/DAT0131_one_point_25C.PLR
SHA256 4808750381DED7503D3A1F166E2E2B5A946AEEC53148AA38538FE751156C48E5

fixtures/e2e/DAT0131_one_point_25C_DMR_export.xls
SHA256 F2197A2D1D61E7D641F377C36A4FB52F3F180949542B8D9D12BD3F6D52021671

fixtures/e2e/DAT0131_realistic_heating_5Cph.PLR
SHA256 035748E5B90D403E0AA438AC9A8CD09976449A752320D0DC00CF1380B03162D9

fixtures/e2e/DAT0131_realistic_heating_5Cph_DMR_export.xls
SHA256 9F4709D705F920CA09F0E1A3228C9586A11EE6C38C62B408C28F99E01A3A1A40

fixtures/e2e/DAT0131_realistic_heating_5Cph_project.json
SHA256 7DB0AF996767EDD6546B3E3CC5A72AC897EE521F52CB747DB4DBAC76185F9908
```

## 7. 自动化回归

`tests-js/core.test.js` 已固化这一 DMR 回读结果。运行：

```powershell
npm.cmd test
```

测试会重新载入原始 PLR/Excel和保存的项目 JSON，然后逐时间、逐通道比对单点、线性、平滑、真实燃烧四组 DMR 回读 Excel。

## 8. 批量编辑追加验收

在单点闭环通过后，又实际生成、打开并由 DMR 导出了两类批量曲线：

| 用例 | 时间范围 | Curve Studio 目标点 | DMR 回读结果（容差 1℃） | 其他有效点 |
|---|---|---:|---:|---:|
| 线性 90℃ -> 110℃ | 2023-11-06 15:40 ～ 16:18 | 20 | 20/20 命中 | 20826/20826 保持 |
| 11 点滑动平滑 | 2023-11-07 06:00 ～ 10:00 | 119 | 119/119 命中 | 20727/20727 保持 |
| 真实燃烧升温合规修复，限制 5℃/h | 2023-11-06 10:00 ～ 13:20 | 100 | 100/100 命中 | 20746/20746 保持 |

回归文件：

```text
fixtures/e2e/DAT0131_linear_90_to_110.PLR
fixtures/e2e/DAT0131_linear_90_to_110_project.json
fixtures/e2e/DAT0131_linear_90_to_110_DMR_export.xls

fixtures/e2e/DAT0131_smooth_window_11.PLR
fixtures/e2e/DAT0131_smooth_window_11_project.json
fixtures/e2e/DAT0131_smooth_window_11_DMR_export.xls

fixtures/e2e/DAT0131_realistic_heating_5Cph.PLR
fixtures/e2e/DAT0131_realistic_heating_5Cph_project.json
fixtures/e2e/DAT0131_realistic_heating_5Cph_DMR_export.xls
```

DMR 当前通道按整数温度导出，因此带小数的线性、平滑、真实燃烧目标使用 1℃（即显示分辨率）容差。全部计划点命中，全部原本有效的非目标点保持。

真实燃烧用例还通过客户升温规则校验：

```text
规则范围：2023-11-06 10:00:00 ～ 13:20:00
滚动窗口：60 min
限制：<= 5℃/h
检查窗口：71
最大观测升温：4.9993124605℃/h
违规窗口：0
PLR 文件长度：76238 字节
实际计划修改：100 点
非目标字节：0
```

开发用自动导出脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dmr_e2e_export.ps1 `
  -PlrPath C:\tmp\dmr-test\DAT0131_linear_90_to_110.PLR `
  -OutputXls fixtures\e2e\DAT0131_linear_90_to_110_DMR_export.xls
```

## 9. 验收结论

当前版本已经证明完整链路成立：

```text
真实 PLR -> Curve Studio 编辑温度 -> 新 PLR -> DMR 3.20 打开 -> DMR Excel 导出 -> 目标逐点匹配
```

单点、线性、滑动平滑和真实燃烧升温合规修复四个用例均通过。
