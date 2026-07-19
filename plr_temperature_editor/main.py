from __future__ import annotations

import argparse
from pathlib import Path
import sys

from .config import load_config
from .excel_reader import read_temperature_excel
from .plr_file import PlrFile
from .report import write_reports
from .rules import apply_rule
from .time_mapper import TimeMapper


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DMR PLR 温度波动修改工具")
    parser.add_argument("--config", required=True, help="JSON 配置文件路径")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    config = load_config(args.config)
    if config.input.output.resolve() == config.input.plr.resolve():
        raise ValueError("output 不能和原始 PLR 文件相同")

    table = read_temperature_excel(config.input.excel)
    plr = PlrFile(config.input.plr, config.plr_format)
    mapper = TimeMapper(config.plr_format)

    all_records = []
    for rule in config.rules:
        all_records.extend(
            apply_rule(
                rule=rule,
                table=table,
                plr=plr,
                mapper=mapper,
                valid_channels=config.plr_format.valid_channels,
                raw_per_celsius=config.plr_format.raw_per_celsius,
            )
        )

    plr.save(config.input.output)
    csv_path, json_path = write_reports(all_records, config.input.output)

    changed = sum(1 for record in all_records if not record.skipped and record.delta_raw != 0)
    unchanged = sum(1 for record in all_records if not record.skipped and record.delta_raw == 0)
    skipped = sum(1 for record in all_records if record.skipped)
    skipped_by_reason: dict[str, int] = {}
    for record in all_records:
        if record.skipped:
            reason = record.skip_reason or "未说明原因"
            skipped_by_reason[reason] = skipped_by_reason.get(reason, 0) + 1
    print("PLR 温度修改完成")
    print(f"输出 PLR：{Path(config.input.output)}")
    print(f"修改记录数：{changed}")
    print(f"无需修改记录数：{unchanged}")
    print(f"跳过记录数：{skipped}")
    if skipped_by_reason:
        print("跳过原因统计：")
        for reason, count in sorted(skipped_by_reason.items()):
            print(f"  {reason}：{count}")
    print(f"CSV 报告：{csv_path}")
    print(f"JSON 报告：{json_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
