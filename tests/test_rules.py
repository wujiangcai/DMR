from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import json
import csv
import struct
import tempfile
import unittest
from unittest.mock import patch

from plr_temperature_editor.config import (
    AutoPreserveDropConfig,
    PlrFormatConfig,
    PreserveRange,
    RuleConfig,
    load_config,
)
from plr_temperature_editor.plr_file import PlrFile
from plr_temperature_editor.compare_export import _read_expected_report, write_compare_report, CompareRow
from plr_temperature_editor.main import main
from plr_temperature_editor.rules import (
    _build_targets,
    _detect_drop_preserve_ranges,
    _is_preserved,
    apply_rule,
)
from plr_temperature_editor.time_mapper import TimeMapper


BASE = datetime(2023, 11, 6, 15, 42)


def times(count: int) -> list[datetime]:
    return [BASE + timedelta(minutes=2 * index) for index in range(count)]


def minimal_config(rule: dict) -> dict:
    return {
        "input": {"plr": "in.PLR", "excel": "curve.xls", "output": "out.PLR"},
        "plr_format": minimal_plr_format(),
        "rules": [rule],
    }


def minimal_plr_format(**overrides: object) -> dict:
    data = {
        "data_offset": 0,
        "record_size": 24,
        "total_records": 3,
        "interval_minutes": 2,
        "buffer_start": "2023-11-06 15:42:00",
        "raw_per_celsius": 48,
        "valid_channels": [1],
    }
    data.update(overrides)
    return data


def write_config(path: Path, rule: dict) -> None:
    path.write_text(json.dumps(minimal_config(rule), ensure_ascii=False), encoding="utf-8")


def write_config_with_format(path: Path, plr_format: dict) -> None:
    config = minimal_config(
        {
            "channel": 1,
            "start": "2023-11-06 15:42:00",
            "end": "2023-11-06 15:46:00",
            "mode": "window_delta_clamp",
            "window_minutes": 10,
            "max_delta": 5,
        }
    )
    config["plr_format"] = plr_format
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")


class RuleTests(unittest.TestCase):
    def test_window_delta_clamp_limits_normal_fluctuation(self) -> None:
        sample_times = times(4)
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
        )

        targets = _build_targets(sample_times, [100, 112, 90, 101], rule)

        values = [targets[time] for time in sample_times]
        self.assertEqual(values, [100, 105, 100, 101])
        self.assertLessEqual(max(value for value in values if value is not None) - min(value for value in values if value is not None), 5)

    def test_window_delta_clamp_restarts_after_preserved_point(self) -> None:
        sample_times = times(5)
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
        )

        targets = _build_targets(sample_times, [100, 102, 70, 72, 90], rule, {sample_times[2]})

        self.assertEqual([targets[time] for time in sample_times], [100, 102, 70, 72, 77])

    def test_window_delta_clamp_uses_actual_time_window(self) -> None:
        sample_times = [BASE, BASE + timedelta(minutes=2), BASE + timedelta(minutes=4)]
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=3,
            max_delta=5,
        )

        targets = _build_targets(sample_times, [100, 103, 110], rule)

        self.assertEqual([targets[time] for time in sample_times], [100, 103, 108])

    def test_window_delta_clamp_applies_absolute_bounds_to_single_point(self) -> None:
        sample_times = [BASE]
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[0],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
            absolute_max=105,
        )

        targets = _build_targets(sample_times, [120], rule)

        self.assertEqual(targets[sample_times[0]], 105)

    def test_auto_preserve_drop_detects_and_extends_drop_range(self) -> None:
        sample_times = times(5)
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
            auto_preserve_drop=AutoPreserveDropConfig(
                enabled=True,
                min_drop=8,
                within_minutes=4,
                extend_after_minutes=2,
                reason="自动保留",
            ),
        )

        ranges = _detect_drop_preserve_ranges(sample_times, [100, 99, 90, 89, 88], rule)

        self.assertEqual(len(ranges), 1)
        self.assertEqual(ranges[0].start, sample_times[0])
        self.assertEqual(ranges[0].end, sample_times[3])
        self.assertEqual(_is_preserved(sample_times[2], ranges), "自动保留")

    def test_manual_preserve_range_still_skips_write(self) -> None:
        sample_times = times(3)
        table = {time: {1: value} for time, value in zip(sample_times, [100, 120, 101])}
        fmt = PlrFormatConfig(
            data_offset=0,
            record_size=24,
            total_records=3,
            interval_minutes=2,
            buffer_start=sample_times[0],
            raw_per_celsius=48,
            valid_channels={1},
        )
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
            preserve_ranges=[PreserveRange(sample_times[1], sample_times[1], "手动保留")],
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.PLR"
            path.write_bytes(bytes(fmt.record_size * fmt.total_records))
            records = apply_rule(rule, table, PlrFile(path, fmt), TimeMapper(fmt), {1}, 48)

        self.assertFalse(records[0].skipped)
        self.assertTrue(records[1].skipped)
        self.assertEqual(records[1].skip_reason, "手动保留")
        self.assertIsNone(records[1].delta_raw)

    def test_zero_delta_records_do_not_touch_plr_bytes(self) -> None:
        sample_times = times(1)
        table = {sample_times[0]: {1: 100}}
        fmt = PlrFormatConfig(
            data_offset=0,
            record_size=24,
            total_records=1,
            interval_minutes=2,
            buffer_start=sample_times[0],
            raw_per_celsius=48,
            valid_channels={1},
        )
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[0],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.PLR"
            data = bytearray(fmt.record_size * fmt.total_records)
            struct.pack_into("<h", data, 2, 1234)
            path.write_bytes(data)
            plr = PlrFile(path, fmt)
            records = apply_rule(rule, table, plr, TimeMapper(fmt), {1}, 48)

        self.assertEqual(records[0].raw_old, 1234)
        self.assertEqual(records[0].raw_new, 1234)
        self.assertEqual(records[0].delta_raw, 0)
        self.assertEqual(plr.data, data)

    def test_auto_preserve_drop_ignores_none_values(self) -> None:
        sample_times = times(4)
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
            auto_preserve_drop=AutoPreserveDropConfig(enabled=True, min_drop=8, within_minutes=4),
        )

        ranges = _detect_drop_preserve_ranges(sample_times, [100, None, 90, None], rule)

        self.assertEqual(ranges, [])

    def test_auto_preserve_drop_defaults_to_adjacent_sample(self) -> None:
        sample_times = times(4)
        rule = RuleConfig(
            channel=1,
            start=sample_times[0],
            end=sample_times[-1],
            mode="window_delta_clamp",
            window_minutes=10,
            max_delta=5,
            auto_preserve_drop=AutoPreserveDropConfig(enabled=True, min_drop=8),
        )

        ranges = _detect_drop_preserve_ranges(sample_times, [100, 96, 92, 88], rule)

        self.assertEqual(ranges, [])

    def test_load_config_parses_auto_preserve_drop(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            path.write_text(
                json.dumps(
                    {
                        "input": {"plr": "in.PLR", "excel": "curve.xls", "output": "out.PLR"},
                        "plr_format": {
                            "data_offset": 0,
                            "record_size": 24,
                            "total_records": 3,
                            "interval_minutes": 2,
                            "buffer_start": "2023-11-06 15:42:00",
                            "raw_per_celsius": 48,
                            "valid_channels": [1],
                        },
                        "rules": [
                            {
                                "channel": 1,
                                "start": "2023-11-06 15:42:00",
                                "end": "2023-11-06 15:46:00",
                                "mode": "window_delta_clamp",
                                "window_minutes": 10,
                                "max_delta": 5,
                                "auto_preserve_drop": {
                                    "enabled": True,
                                    "min_drop": 8,
                                    "within_minutes": 10,
                                    "extend_before_minutes": 2,
                                    "extend_after_minutes": 30,
                                    "reason": "自动保留",
                                },
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            rule = load_config(path).rules[0]

        self.assertIsNotNone(rule.auto_preserve_drop)
        self.assertEqual(rule.auto_preserve_drop.min_drop, 8)
        self.assertEqual(rule.auto_preserve_drop.extend_after_minutes, 30)
        self.assertEqual(rule.auto_preserve_drop.reason, "自动保留")

    def test_load_config_rejects_reversed_rule_range(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            path.write_text(
                json.dumps(
                    {
                        "input": {"plr": "in.PLR", "excel": "curve.xls", "output": "out.PLR"},
                        "plr_format": {
                            "data_offset": 0,
                            "record_size": 24,
                            "total_records": 3,
                            "interval_minutes": 2,
                            "buffer_start": "2023-11-06 15:42:00",
                            "raw_per_celsius": 48,
                            "valid_channels": [1],
                        },
                        "rules": [
                            {
                                "channel": 1,
                                "start": "2023-11-06 15:46:00",
                                "end": "2023-11-06 15:42:00",
                                "mode": "window_delta_clamp",
                                "window_minutes": 10,
                                "max_delta": 5,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "规则 start 不能晚于 end"):
                load_config(path)

    def test_load_config_rejects_reversed_preserve_range(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            path.write_text(
                json.dumps(
                    {
                        "input": {"plr": "in.PLR", "excel": "curve.xls", "output": "out.PLR"},
                        "plr_format": {
                            "data_offset": 0,
                            "record_size": 24,
                            "total_records": 3,
                            "interval_minutes": 2,
                            "buffer_start": "2023-11-06 15:42:00",
                            "raw_per_celsius": 48,
                            "valid_channels": [1],
                        },
                        "rules": [
                            {
                                "channel": 1,
                                "start": "2023-11-06 15:42:00",
                                "end": "2023-11-06 15:46:00",
                                "mode": "window_delta_clamp",
                                "window_minutes": 10,
                                "max_delta": 5,
                                "preserve_ranges": [
                                    {
                                        "start": "2023-11-06 15:46:00",
                                        "end": "2023-11-06 15:44:00",
                                    }
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "preserve_ranges 的 start 不能晚于 end"):
                load_config(path)

    def test_load_config_rejects_reversed_absolute_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            path.write_text(
                json.dumps(
                    {
                        "input": {"plr": "in.PLR", "excel": "curve.xls", "output": "out.PLR"},
                        "plr_format": {
                            "data_offset": 0,
                            "record_size": 24,
                            "total_records": 3,
                            "interval_minutes": 2,
                            "buffer_start": "2023-11-06 15:42:00",
                            "raw_per_celsius": 48,
                            "valid_channels": [1],
                        },
                        "rules": [
                            {
                                "channel": 1,
                                "start": "2023-11-06 15:42:00",
                                "end": "2023-11-06 15:46:00",
                                "mode": "window_delta_clamp",
                                "window_minutes": 10,
                                "max_delta": 5,
                                "absolute_min": 120,
                                "absolute_max": 100,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "absolute_min 不能大于 absolute_max"):
                load_config(path)

    def test_load_config_rejects_invalid_mode_numbers(self) -> None:
        cases = [
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "window_delta_clamp",
                    "window_minutes": 0,
                    "max_delta": 5,
                },
                "window_minutes 必须大于 0",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "window_delta_clamp",
                    "window_minutes": 10,
                    "max_delta": -1,
                },
                "max_delta 不能为负数",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "trend_clamp",
                    "allowed_deviation": -1,
                },
                "allowed_deviation 不能为负数",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "trend_clamp",
                    "allowed_deviation": 3,
                    "smooth_window": 0,
                },
                "smooth_window 必须大于 0",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            for rule, message in cases:
                write_config(path, rule)
                with self.assertRaisesRegex(ValueError, message):
                    load_config(path)

    def test_load_config_rejects_missing_required_mode_numbers(self) -> None:
        cases = [
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "window_delta_clamp",
                    "window_minutes": 10,
                },
                "window_delta_clamp 模式需要配置 window_minutes 和 max_delta",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "trend_clamp",
                },
                "trend_clamp 模式需要配置 allowed_deviation",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "offset",
                },
                "offset 模式需要配置 offset",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "absolute_clamp",
                },
                "absolute_clamp 模式需要配置 absolute_min 或 absolute_max",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "bad_mode",
                },
                "不支持的模式",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            for rule, message in cases:
                write_config(path, rule)
                with self.assertRaisesRegex(ValueError, message):
                    load_config(path)

    def test_load_config_rejects_invalid_plr_format_numbers(self) -> None:
        cases = [
            (minimal_plr_format(data_offset=-1), "data_offset 不能为负数"),
            (minimal_plr_format(record_size=0), "record_size 必须大于 0"),
            (minimal_plr_format(total_records=0), "total_records 必须大于 0"),
            (minimal_plr_format(interval_minutes=0), "interval_minutes 必须大于 0"),
            (minimal_plr_format(raw_per_celsius=0), "raw_per_celsius 必须大于 0"),
            (minimal_plr_format(record_size=2, valid_channels=[1]), "valid_channels 中存在超出 record_size 的通道"),
            (
                minimal_plr_format(anchor_time="2023-11-06 15:42:00", anchor_record_index=3),
                "anchor_record_index 必须在记录范围内",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            for plr_format, message in cases:
                write_config_with_format(path, plr_format)
                with self.assertRaisesRegex(ValueError, message):
                    load_config(path)

    def test_load_config_rejects_invalid_rule_channels(self) -> None:
        cases = [
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "window_delta_clamp",
                    "window_minutes": 10,
                    "max_delta": 5,
                },
                minimal_plr_format(valid_channels=[2]),
                "通道 1 未在 valid_channels 中启用",
            ),
            (
                {
                    "channel": 1,
                    "start": "2023-11-06 15:42:00",
                    "end": "2023-11-06 15:46:00",
                    "mode": "window_delta_clamp",
                    "window_minutes": 10,
                    "max_delta": 5,
                },
                minimal_plr_format(record_size=2, valid_channels=[]),
                "规则 channel 超出 record_size 可写范围",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.json"
            for rule, plr_format, message in cases:
                config = minimal_config(rule)
                config["plr_format"] = plr_format
                path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, message):
                    load_config(path)

    def test_main_prints_skipped_reason_summary(self) -> None:
        sample_times = times(3)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plr_path = root / "sample.PLR"
            excel_path = root / "curve.xls"
            output_path = root / "out.PLR"
            config_path = root / "rule.json"
            data = bytearray(24 * 3)
            for index, value in enumerate([4800, 5760, 4848]):
                struct.pack_into("<h", data, index * 24 + 2, value)
            plr_path.write_bytes(data)
            config_path.write_text(
                json.dumps(
                    {
                        "input": {
                            "plr": str(plr_path),
                            "excel": str(excel_path),
                            "output": str(output_path),
                        },
                        "plr_format": {
                            "data_offset": 0,
                            "record_size": 24,
                            "total_records": 3,
                            "interval_minutes": 2,
                            "buffer_start": "2023-11-06 15:42:00",
                            "raw_per_celsius": 48,
                            "valid_channels": [1],
                        },
                        "rules": [
                            {
                                "channel": 1,
                                "start": "2023-11-06 15:42:00",
                                "end": "2023-11-06 15:46:00",
                                "mode": "window_delta_clamp",
                                "window_minutes": 10,
                                "max_delta": 5,
                                "preserve_ranges": [
                                    {
                                        "start": "2023-11-06 15:44:00",
                                        "end": "2023-11-06 15:44:00",
                                        "reason": "手动保留",
                                    }
                                ],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            table = {time: {1: value} for time, value in zip(sample_times, [100, 120, 101])}
            with patch("plr_temperature_editor.main.read_temperature_excel", return_value=table), patch("builtins.print") as print_mock:
                self.assertEqual(main(["--config", str(config_path)]), 0)

        printed = [str(call.args[0]) for call in print_mock.call_args_list]
        self.assertIn("跳过原因统计：", printed)
        self.assertIn("  手动保留：1", printed)
        self.assertIn("无需修改记录数：2", printed)

    def test_compare_export_uses_skipped_targets_as_expected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.csv"
            with report_path.open("w", encoding="utf-8-sig", newline="") as f:
                writer = csv.DictWriter(
                    f,
                    fieldnames=[
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
                    ],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "time": "2023-11-06 15:44:00",
                        "channel": "1",
                        "mode": "window_delta_clamp",
                        "original_temp": "120",
                        "target_temp": "120",
                        "delta_temp": "0.0",
                        "record_index": "",
                        "field_index": "1",
                        "raw_old": "",
                        "raw_new": "",
                        "delta_raw": "",
                        "skipped": "True",
                        "skip_reason": "自动保留",
                    }
                )

            expected = _read_expected_report(report_path)

        row = expected[(datetime(2023, 11, 6, 15, 44), 1)]
        self.assertEqual(row.target_temp, 120)
        self.assertTrue(row.skipped)
        self.assertEqual(row.skip_reason, "自动保留")

    def test_write_compare_report_includes_skip_details(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "compare.csv"
            write_compare_report(
                [
                    CompareRow(
                        time=datetime(2023, 11, 6, 15, 44),
                        channel=1,
                        original_temp=120,
                        modified_temp=120,
                        expected_temp=120,
                        modified_minus_original=0,
                        modified_minus_expected=0,
                        status="ok",
                        skipped=True,
                        skip_reason="自动保留",
                    )
                ],
                output,
            )

            with output.open("r", encoding="utf-8-sig", newline="") as f:
                rows = list(csv.DictReader(f))

        self.assertEqual(rows[0]["skipped"], "True")
        self.assertEqual(rows[0]["skip_reason"], "自动保留")


if __name__ == "__main__":
    unittest.main()
