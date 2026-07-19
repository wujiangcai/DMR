from __future__ import annotations

from datetime import datetime, timedelta

from .config import PreserveRange, RuleConfig, SUPPORTED_MODES
from .excel_reader import TemperatureTable
from .plr_file import PlrFile
from .report import ChangeRecord
from .time_mapper import TimeMapper
from .trend import clamp, moving_average



def _is_preserved(time: datetime, ranges: list[PreserveRange]) -> str | None:
    for item in ranges:
        if item.start <= time <= item.end:
            return item.reason
    return None


def _detect_drop_preserve_ranges(times: list[datetime], values: list[float | None], rule: RuleConfig) -> list[PreserveRange]:
    config = rule.auto_preserve_drop
    if config is None or not config.enabled:
        return []

    ranges: list[PreserveRange] = []
    for index, (time, current) in enumerate(zip(times, values)):
        if current is None or _is_preserved(time, ranges):
            continue

        previous_items: list[tuple[datetime, float]] = []
        for previous_time, previous in reversed(list(zip(times[:index], values[:index]))):
            if previous is None:
                break
            if config.within_minutes is None:
                previous_items.append((previous_time, previous))
                break
            minutes = (time - previous_time).total_seconds() / 60
            if minutes > config.within_minutes:
                break
            previous_items.append((previous_time, previous))

        if not previous_items:
            continue
        previous_time, previous = max(previous_items, key=lambda item: item[1])
        if previous - current < config.min_drop:
            continue

        # Keep the shutdown/drop curve itself, with optional context around it.
        start = previous_time - timedelta(minutes=config.extend_before_minutes)
        end = time + timedelta(minutes=config.extend_after_minutes)
        ranges.append(
            PreserveRange(
                start=max(rule.start, start),
                end=min(rule.end, end),
                reason=config.reason,
            )
        )
    return _merge_preserve_ranges(ranges)


def _merge_preserve_ranges(ranges: list[PreserveRange]) -> list[PreserveRange]:
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda item: (item.start, item.end, item.reason))
    merged: list[PreserveRange] = [ordered[0]]
    for item in ordered[1:]:
        last = merged[-1]
        if item.start <= last.end and item.reason == last.reason:
            merged[-1] = PreserveRange(start=last.start, end=max(last.end, item.end), reason=last.reason)
        else:
            merged.append(item)
    return merged


def _preserved_times(times: list[datetime], ranges: list[PreserveRange]) -> set[datetime]:
    return {time for time in times if _is_preserved(time, ranges)}


def _times_in_range(table: TemperatureTable, start: datetime, end: datetime) -> list[datetime]:
    return sorted(time for time in table if start <= time <= end)


def _target_for_offset(current: float, rule: RuleConfig) -> float:
    if rule.offset is None:
        raise ValueError("offset 模式需要配置 offset")
    return current + rule.offset


def _target_for_absolute_clamp(current: float, rule: RuleConfig) -> float:
    if rule.absolute_min is None and rule.absolute_max is None:
        raise ValueError("absolute_clamp 模式需要配置 absolute_min 或 absolute_max")
    return clamp(current, rule.absolute_min, rule.absolute_max)


def _targets_for_trend_clamp(times: list[datetime], values: list[float | None], rule: RuleConfig) -> dict[datetime, float | None]:
    if rule.allowed_deviation is None:
        raise ValueError("trend_clamp 模式需要配置 allowed_deviation")
    trends = moving_average(values, rule.smooth_window)
    targets: dict[datetime, float | None] = {}
    for time, current, trend in zip(times, values, trends):
        if current is None or trend is None:
            targets[time] = None
            continue
        deviation = current - trend
        limited = clamp(deviation, -rule.allowed_deviation, rule.allowed_deviation)
        target = trend + limited
        target = clamp(target, rule.absolute_min, rule.absolute_max)
        targets[time] = target
    return targets


def _targets_for_window_delta_clamp(
    times: list[datetime],
    values: list[float | None],
    rule: RuleConfig,
    preserved_times: set[datetime],
) -> dict[datetime, float | None]:
    if rule.window_minutes is None or rule.max_delta is None:
        raise ValueError("window_delta_clamp 模式需要配置 window_minutes 和 max_delta")
    if rule.window_minutes <= 0:
        raise ValueError("window_minutes 必须大于 0")
    if rule.max_delta < 0:
        raise ValueError("max_delta 不能为负数")
    if len(times) < 2:
        return {
            time: None if value is None else clamp(value, rule.absolute_min, rule.absolute_max)
            for time, value in zip(times, values)
        }

    targets: dict[datetime, float | None] = {}
    adjusted: list[float | None] = []
    for index, (time, current) in enumerate(zip(times, values)):
        if current is None:
            targets[time] = None
            adjusted.append(None)
            continue
        if time in preserved_times:
            targets[time] = current
            adjusted.append(None)
            continue

        window_start_time = time - timedelta(minutes=rule.window_minutes)
        recent_adjusted = [
            adjusted_value
            for previous_time, adjusted_value in zip(times[:index], adjusted)
            if previous_time >= window_start_time
        ]
        for offset in range(len(recent_adjusted) - 1, -1, -1):
            if recent_adjusted[offset] is None:
                recent_adjusted = recent_adjusted[offset + 1:]
                break
        window_values = [value for value in recent_adjusted if value is not None]
        if not window_values:
            target = current
        else:
            # For every rolling window ending at this point, force max-min <= max_delta.
            lower = max(window_values) - rule.max_delta
            upper = min(window_values) + rule.max_delta
            if lower > upper:
                center = sum(window_values) / len(window_values)
                lower = center - rule.max_delta / 2
                upper = center + rule.max_delta / 2
            target = clamp(current, lower, upper)
        target = clamp(target, rule.absolute_min, rule.absolute_max)
        targets[time] = target
        adjusted.append(target)
    return targets


def _build_targets(
    times: list[datetime],
    values: list[float | None],
    rule: RuleConfig,
    preserved_times: set[datetime] | None = None,
) -> dict[datetime, float | None]:
    if rule.mode == "trend_clamp":
        return _targets_for_trend_clamp(times, values, rule)
    if rule.mode == "window_delta_clamp":
        return _targets_for_window_delta_clamp(times, values, rule, preserved_times or set())

    targets: dict[datetime, float | None] = {}
    for time, current in zip(times, values):
        if current is None:
            targets[time] = None
        elif rule.mode == "offset":
            targets[time] = _target_for_offset(current, rule)
        else:
            targets[time] = _target_for_absolute_clamp(current, rule)
    return targets


def apply_rule(
    rule: RuleConfig,
    table: TemperatureTable,
    plr: PlrFile,
    mapper: TimeMapper,
    valid_channels: set[int],
    raw_per_celsius: float,
) -> list[ChangeRecord]:
    if rule.mode not in SUPPORTED_MODES:
        raise ValueError(f"不支持的模式：{rule.mode}，可选：{sorted(SUPPORTED_MODES)}")
    if valid_channels and rule.channel not in valid_channels:
        raise ValueError(f"通道 {rule.channel} 未在 valid_channels 中启用")

    times = _times_in_range(table, rule.start, rule.end)
    if not times:
        raise ValueError(f"规则时间范围内没有 Excel 数据：{rule.start} - {rule.end}")

    values = [table[time].get(rule.channel) for time in times]
    preserve_ranges = _merge_preserve_ranges(
        [*rule.preserve_ranges, *_detect_drop_preserve_ranges(times, values, rule)]
    )
    targets = _build_targets(times, values, rule, _preserved_times(times, preserve_ranges))

    records: list[ChangeRecord] = []
    field_index = rule.channel
    for time, current in zip(times, values):
        preserve_reason = _is_preserved(time, preserve_ranges)
        if preserve_reason:
            records.append(
                ChangeRecord(
                    time=time,
                    channel=rule.channel,
                    mode=rule.mode,
                    original_temp=current,
                    target_temp=current,
                    delta_temp=0.0 if current is not None else None,
                    record_index=None,
                    field_index=field_index,
                    raw_old=None,
                    raw_new=None,
                    delta_raw=None,
                    skipped=True,
                    skip_reason=preserve_reason,
                )
            )
            continue

        target = targets[time]
        if current is None or target is None:
            records.append(
                ChangeRecord(
                    time=time,
                    channel=rule.channel,
                    mode=rule.mode,
                    original_temp=current,
                    target_temp=target,
                    delta_temp=None,
                    record_index=None,
                    field_index=field_index,
                    raw_old=None,
                    raw_new=None,
                    delta_raw=None,
                    skipped=True,
                    skip_reason="无效温度点，跳过",
                )
            )
            continue

        delta_temp = target - current
        delta_raw = round(delta_temp * raw_per_celsius)
        record_index = mapper.time_to_record_index(time)
        raw_old = plr.read_raw(record_index, field_index)
        raw_new = raw_old if delta_raw == 0 else plr.write_raw(record_index, field_index, raw_old + delta_raw)
        records.append(
            ChangeRecord(
                time=time,
                channel=rule.channel,
                mode=rule.mode,
                original_temp=current,
                target_temp=target,
                delta_temp=delta_temp,
                record_index=record_index,
                field_index=field_index,
                raw_old=raw_old,
                raw_new=raw_new,
                delta_raw=raw_new - raw_old,
                skipped=False,
            )
        )
    return records
