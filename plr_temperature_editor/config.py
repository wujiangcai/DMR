from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
import json
from typing import Any


DATETIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d %H:%M:%S",
)

SUPPORTED_MODES = {"offset", "absolute_clamp", "trend_clamp", "window_delta_clamp"}


@dataclass(frozen=True)
class InputConfig:
    plr: Path
    excel: Path
    output: Path


@dataclass(frozen=True)
class PlrFormatConfig:
    data_offset: int
    record_size: int
    total_records: int
    interval_minutes: int
    buffer_start: datetime
    raw_per_celsius: float
    valid_channels: set[int]
    anchor_time: datetime | None = None
    anchor_record_index: int | None = None


@dataclass(frozen=True)
class PreserveRange:
    start: datetime
    end: datetime
    reason: str = "保留时间段"


@dataclass(frozen=True)
class AutoPreserveDropConfig:
    enabled: bool = False
    min_drop: float = 0.0
    within_minutes: int | None = None
    extend_before_minutes: int = 0
    extend_after_minutes: int = 0
    reason: str = "自动保留停火骤降段"


@dataclass(frozen=True)
class RuleConfig:
    channel: int
    start: datetime
    end: datetime
    mode: str
    offset: float | None = None
    allowed_deviation: float | None = None
    absolute_min: float | None = None
    absolute_max: float | None = None
    smooth_window: int = 5
    window_minutes: int | None = None
    max_delta: float | None = None
    preserve_ranges: list[PreserveRange] = field(default_factory=list)
    auto_preserve_drop: AutoPreserveDropConfig | None = None


@dataclass(frozen=True)
class AppConfig:
    input: InputConfig
    plr_format: PlrFormatConfig
    rules: list[RuleConfig]


def parse_datetime(value: str) -> datetime:
    for fmt in DATETIME_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass
    raise ValueError(f"不支持的时间格式：{value!r}，请使用 YYYY-MM-DD HH:MM:SS")


def _optional_float(data: dict[str, Any], key: str) -> float | None:
    value = data.get(key)
    if value is None:
        return None
    return float(value)


def _optional_int(data: dict[str, Any], key: str) -> int | None:
    value = data.get(key)
    if value is None:
        return None
    return int(value)


def _parse_auto_preserve_drop(data: dict[str, Any]) -> AutoPreserveDropConfig | None:
    raw = data.get("auto_preserve_drop")
    if raw is None:
        return None
    enabled = bool(raw.get("enabled", False))
    min_drop = float(raw.get("min_drop", 0.0))
    if enabled and min_drop <= 0:
        raise ValueError("auto_preserve_drop.min_drop 必须大于 0")
    extend_before_minutes = int(raw.get("extend_before_minutes", 0))
    extend_after_minutes = int(raw.get("extend_after_minutes", 0))
    if extend_before_minutes < 0 or extend_after_minutes < 0:
        raise ValueError("auto_preserve_drop 的延伸时间不能为负数")
    within_minutes = _optional_int(raw, "within_minutes")
    if within_minutes is not None and within_minutes <= 0:
        raise ValueError("auto_preserve_drop.within_minutes 必须大于 0")
    return AutoPreserveDropConfig(
        enabled=enabled,
        min_drop=min_drop,
        within_minutes=within_minutes,
        extend_before_minutes=extend_before_minutes,
        extend_after_minutes=extend_after_minutes,
        reason=str(raw.get("reason", "自动保留停火骤降段")),
    )


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    input_raw = raw["input"]
    input_config = InputConfig(
        plr=Path(input_raw["plr"]),
        excel=Path(input_raw["excel"]),
        output=Path(input_raw["output"]),
    )

    format_raw = raw["plr_format"]
    valid_channels = {int(ch) for ch in format_raw.get("valid_channels", [])}
    anchor_time = format_raw.get("anchor_time")
    anchor_record_index = format_raw.get("anchor_record_index")
    plr_format = PlrFormatConfig(
        data_offset=int(format_raw["data_offset"]),
        record_size=int(format_raw["record_size"]),
        total_records=int(format_raw["total_records"]),
        interval_minutes=int(format_raw["interval_minutes"]),
        buffer_start=parse_datetime(format_raw["buffer_start"]),
        raw_per_celsius=float(format_raw["raw_per_celsius"]),
        valid_channels=valid_channels,
        anchor_time=parse_datetime(anchor_time) if anchor_time else None,
        anchor_record_index=int(anchor_record_index) if anchor_record_index is not None else None,
    )
    if plr_format.data_offset < 0:
        raise ValueError("data_offset 不能为负数")
    if plr_format.record_size <= 0:
        raise ValueError("record_size 必须大于 0")
    if plr_format.total_records <= 0:
        raise ValueError("total_records 必须大于 0")
    if plr_format.interval_minutes <= 0:
        raise ValueError("interval_minutes 必须大于 0")
    if plr_format.raw_per_celsius <= 0:
        raise ValueError("raw_per_celsius 必须大于 0")
    if any(channel < 0 or channel * 2 + 2 > plr_format.record_size for channel in valid_channels):
        raise ValueError("valid_channels 中存在超出 record_size 的通道")
    if (plr_format.anchor_time is None) != (plr_format.anchor_record_index is None):
        raise ValueError("anchor_time 和 anchor_record_index 必须同时配置或同时省略")
    if plr_format.anchor_record_index is not None and not 0 <= plr_format.anchor_record_index < plr_format.total_records:
        raise ValueError("anchor_record_index 必须在记录范围内")

    rules: list[RuleConfig] = []
    for rule_raw in raw.get("rules", []):
        rule_start = parse_datetime(rule_raw["start"])
        rule_end = parse_datetime(rule_raw["end"])
        if rule_start > rule_end:
            raise ValueError("规则 start 不能晚于 end")

        preserve_ranges: list[PreserveRange] = []
        for item in rule_raw.get("preserve_ranges", []):
            preserve_start = parse_datetime(item["start"])
            preserve_end = parse_datetime(item["end"])
            if preserve_start > preserve_end:
                raise ValueError("preserve_ranges 的 start 不能晚于 end")
            preserve_ranges.append(
                PreserveRange(
                    start=preserve_start,
                    end=preserve_end,
                    reason=item.get("reason", "保留时间段"),
                )
            )
        absolute_min = _optional_float(rule_raw, "absolute_min")
        absolute_max = _optional_float(rule_raw, "absolute_max")
        if absolute_min is not None and absolute_max is not None and absolute_min > absolute_max:
            raise ValueError("absolute_min 不能大于 absolute_max")
        mode = str(rule_raw["mode"])
        if mode not in SUPPORTED_MODES:
            raise ValueError(f"不支持的模式：{mode}，可选：{sorted(SUPPORTED_MODES)}")
        allowed_deviation = _optional_float(rule_raw, "allowed_deviation")
        if allowed_deviation is not None and allowed_deviation < 0:
            raise ValueError("allowed_deviation 不能为负数")
        smooth_window = int(rule_raw.get("smooth_window", 5))
        if smooth_window <= 0:
            raise ValueError("smooth_window 必须大于 0")
        window_minutes = int(rule_raw["window_minutes"]) if rule_raw.get("window_minutes") is not None else None
        if window_minutes is not None and window_minutes <= 0:
            raise ValueError("window_minutes 必须大于 0")
        max_delta = _optional_float(rule_raw, "max_delta")
        if max_delta is not None and max_delta < 0:
            raise ValueError("max_delta 不能为负数")
        offset = _optional_float(rule_raw, "offset")
        if mode == "offset" and offset is None:
            raise ValueError("offset 模式需要配置 offset")
        if mode == "absolute_clamp" and absolute_min is None and absolute_max is None:
            raise ValueError("absolute_clamp 模式需要配置 absolute_min 或 absolute_max")
        if mode == "trend_clamp" and allowed_deviation is None:
            raise ValueError("trend_clamp 模式需要配置 allowed_deviation")
        if mode == "window_delta_clamp" and (window_minutes is None or max_delta is None):
            raise ValueError("window_delta_clamp 模式需要配置 window_minutes 和 max_delta")
        channel = int(rule_raw["channel"])
        if channel < 0 or channel * 2 + 2 > plr_format.record_size:
            raise ValueError("规则 channel 超出 record_size 可写范围")
        if valid_channels and channel not in valid_channels:
            raise ValueError(f"通道 {channel} 未在 valid_channels 中启用")

        rules.append(
            RuleConfig(
                channel=channel,
                start=rule_start,
                end=rule_end,
                mode=mode,
                offset=offset,
                allowed_deviation=allowed_deviation,
                absolute_min=absolute_min,
                absolute_max=absolute_max,
                smooth_window=smooth_window,
                window_minutes=window_minutes,
                max_delta=max_delta,
                preserve_ranges=preserve_ranges,
                auto_preserve_drop=_parse_auto_preserve_drop(rule_raw),
            )
        )

    if not rules:
        raise ValueError("配置中至少需要一条 rules 规则")

    return AppConfig(input=input_config, plr_format=plr_format, rules=rules)
