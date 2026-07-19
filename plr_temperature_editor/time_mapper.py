from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import PlrFormatConfig


@dataclass(frozen=True)
class TimeMapper:
    fmt: PlrFormatConfig

    @property
    def interval(self) -> timedelta:
        return timedelta(minutes=self.fmt.interval_minutes)

    def _base_time_and_index(self) -> tuple[datetime, int]:
        if self.fmt.anchor_time is not None and self.fmt.anchor_record_index is not None:
            return self.fmt.anchor_time, self.fmt.anchor_record_index
        return self.fmt.buffer_start, 0

    def time_to_record_index(self, time: datetime) -> int:
        base_time, base_index = self._base_time_and_index()
        delta = time - base_time
        interval_seconds = self.interval.total_seconds()
        seconds = delta.total_seconds()
        if seconds % interval_seconds != 0:
            raise ValueError(f"时间未对齐采样间隔：{time}")
        index = base_index + int(seconds // interval_seconds)
        if index < 0 or index >= self.fmt.total_records:
            raise ValueError(f"时间超出 PLR 缓冲区范围：{time}")
        return index

    def record_index_to_time(self, record_index: int) -> datetime:
        if record_index < 0 or record_index >= self.fmt.total_records:
            raise ValueError(f"record_index 越界：{record_index}")
        base_time, base_index = self._base_time_and_index()
        return base_time + (record_index - base_index) * self.interval
