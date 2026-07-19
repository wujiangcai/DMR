from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import csv
import sys

from .config import parse_datetime
from .excel_reader import read_temperature_excel


@dataclass
class ExpectedReportRow:
    target_temp: float | None
    skipped: bool
    skip_reason: str


@dataclass
class CompareRow:
    time: datetime
    channel: int
    original_temp: float | None
    modified_temp: float | None
    expected_temp: float | None
    modified_minus_original: float | None
    modified_minus_expected: float | None
    status: str
    skipped: bool = False
    skip_reason: str = ""


def _float_or_none(value: str) -> float | None:
    if value == "" or value.lower() == "none":
        return None
    return float(value)


def _is_true(value: str | None) -> bool:
    return str(value).lower() == "true"


def _read_expected_report(path: Path) -> dict[tuple[datetime, int], ExpectedReportRow]:
    expected: dict[tuple[datetime, int], ExpectedReportRow] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            time = parse_datetime(row["time"])
            channel = int(row["channel"])
            expected[(time, channel)] = ExpectedReportRow(
                target_temp=_float_or_none(row.get("target_temp", "")),
                skipped=_is_true(row.get("skipped")),
                skip_reason=row.get("skip_reason", ""),
            )
    return expected


def _diff(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return a - b


def compare_exports(
    original_excel: Path,
    modified_excel: Path,
    report_csv: Path | None,
    channel: int,
    start: datetime | None,
    end: datetime | None,
    tolerance: float,
) -> list[CompareRow]:
    original = read_temperature_excel(original_excel)
    modified = read_temperature_excel(modified_excel)
    expected = _read_expected_report(report_csv) if report_csv else {}

    times = sorted(set(original) & set(modified))
    rows: list[CompareRow] = []
    for time in times:
        if start and time < start:
            continue
        if end and time > end:
            continue
        original_temp = original[time].get(channel)
        modified_temp = modified[time].get(channel)
        expected_row = expected.get((time, channel))
        expected_temp = expected_row.target_temp if expected_row else None
        modified_minus_expected = _diff(modified_temp, expected_temp)
        if expected_row is None or expected_temp is None:
            status = "no_expected"
        elif modified_temp is None:
            status = "missing_modified"
        elif abs(modified_temp - expected_temp) <= tolerance:
            status = "ok"
        else:
            status = "mismatch"
        rows.append(
            CompareRow(
                time=time,
                channel=channel,
                original_temp=original_temp,
                modified_temp=modified_temp,
                expected_temp=expected_temp,
                modified_minus_original=_diff(modified_temp, original_temp),
                modified_minus_expected=modified_minus_expected,
                status=status,
                skipped=expected_row.skipped if expected_row else False,
                skip_reason=expected_row.skip_reason if expected_row else "",
            )
        )
    return rows


def write_compare_report(rows: list[CompareRow], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "time",
        "channel",
        "original_temp",
        "modified_temp",
        "expected_temp",
        "modified_minus_original",
        "modified_minus_expected",
        "status",
        "skipped",
        "skip_reason",
    ]
    with output.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "time": row.time.strftime("%Y-%m-%d %H:%M:%S"),
                    "channel": row.channel,
                    "original_temp": row.original_temp,
                    "modified_temp": row.modified_temp,
                    "expected_temp": row.expected_temp,
                    "modified_minus_original": row.modified_minus_original,
                    "modified_minus_expected": row.modified_minus_expected,
                    "status": row.status,
                    "skipped": row.skipped,
                    "skip_reason": row.skip_reason,
                }
            )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="对比 DMR 修改前后导出的 Excel")
    parser.add_argument("--original-excel", required=True, help="原始 DMR 导出 Excel")
    parser.add_argument("--modified-excel", required=True, help="修改后 PLR 再由 DMR 导出的 Excel")
    parser.add_argument("--report-csv", help="PLR 修改器生成的 CSV 报告")
    parser.add_argument("--channel", type=int, required=True, help="要对比的通道号，例如 1")
    parser.add_argument("--start", help="起始时间，YYYY-MM-DD HH:MM:SS")
    parser.add_argument("--end", help="结束时间，YYYY-MM-DD HH:MM:SS")
    parser.add_argument("--tolerance", type=float, default=1.0, help="与预期温度的允许误差，默认 1℃")
    parser.add_argument("--output", required=True, help="输出对比 CSV")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    rows = compare_exports(
        original_excel=Path(args.original_excel),
        modified_excel=Path(args.modified_excel),
        report_csv=Path(args.report_csv) if args.report_csv else None,
        channel=args.channel,
        start=parse_datetime(args.start) if args.start else None,
        end=parse_datetime(args.end) if args.end else None,
        tolerance=args.tolerance,
    )
    write_compare_report(rows, Path(args.output))
    status_counts: dict[str, int] = {}
    for row in rows:
        status_counts[row.status] = status_counts.get(row.status, 0) + 1
    print("Excel 对比完成")
    print(f"对比记录数：{len(rows)}")
    print(f"状态统计：{status_counts}")
    print(f"输出报告：{Path(args.output)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
