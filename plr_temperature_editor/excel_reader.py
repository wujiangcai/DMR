from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re
from typing import Any

import xlrd

from .config import parse_datetime

INVALID_TEMPERATURE = -32640.0
CHANNEL_HEADER_RE = re.compile(r"通道\s*0*(\d+)")


TemperatureTable = dict[datetime, dict[int, float | None]]


def _as_float(value: Any) -> float | None:
    if value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number == INVALID_TEMPERATURE:
        return None
    return number


def _parse_time_cell(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return parse_datetime(value.strip())
    raise ValueError(f"无法解析 Excel 时间单元格：{value!r}")


def read_temperature_excel(path: str | Path) -> TemperatureTable:
    workbook = xlrd.open_workbook(str(path))
    sheet = workbook.sheet_by_index(0)
    if sheet.nrows < 2:
        raise ValueError("Excel 中没有可读取的数据行")

    headers = [str(sheet.cell_value(0, col)).strip() for col in range(sheet.ncols)]
    try:
        time_col = headers.index("时间")
    except ValueError as exc:
        raise ValueError("Excel 表头中未找到“时间”列") from exc

    channel_cols: dict[int, int] = {}
    for col, header in enumerate(headers):
        match = CHANNEL_HEADER_RE.search(header)
        if match:
            channel_cols[int(match.group(1))] = col

    if not channel_cols:
        raise ValueError("Excel 表头中未找到通道列，例如 通道01(℃)")

    table: TemperatureTable = {}
    for row in range(1, sheet.nrows):
        raw_time = sheet.cell_value(row, time_col)
        if raw_time == "":
            continue
        time = _parse_time_cell(raw_time)
        channels: dict[int, float | None] = {}
        for channel, col in channel_cols.items():
            channels[channel] = _as_float(sheet.cell_value(row, col))
        table[time] = channels

    if not table:
        raise ValueError("Excel 中没有解析到任何温度数据")
    return table
