from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
import csv
import json
from typing import Any


@dataclass
class ChangeRecord:
    time: datetime
    channel: int
    mode: str
    original_temp: float | None
    target_temp: float | None
    delta_temp: float | None
    record_index: int | None
    field_index: int
    raw_old: int | None
    raw_new: int | None
    delta_raw: int | None
    skipped: bool
    skip_reason: str = ""

    def to_row(self) -> dict[str, Any]:
        row = asdict(self)
        row["time"] = self.time.strftime("%Y-%m-%d %H:%M:%S")
        return row


def write_reports(records: list[ChangeRecord], output_plr: str | Path) -> tuple[Path, Path]:
    output = Path(output_plr)
    stem = output.with_suffix("")
    csv_path = stem.with_name(stem.name + "_report.csv")
    json_path = stem.with_name(stem.name + "_report.json")
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "time",
        "channel",
        "mode",
        "original_temp",
        "target_temp",
        "delta_temp",
        "record_index",
        "field_index",
        "raw_old",
        "raw_new",
        "delta_raw",
        "skipped",
        "skip_reason",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            writer.writerow(record.to_row())

    with json_path.open("w", encoding="utf-8") as f:
        json.dump([record.to_row() for record in records], f, ensure_ascii=False, indent=2)

    return csv_path, json_path
