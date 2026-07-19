from __future__ import annotations

from pathlib import Path
import struct

from .config import PlrFormatConfig

INT16_MIN = -32768
INT16_MAX = 32767


class PlrFile:
    def __init__(self, path: str | Path, fmt: PlrFormatConfig):
        self.path = Path(path)
        self.fmt = fmt
        self.data = bytearray(self.path.read_bytes())
        self._validate_size()

    def _validate_size(self) -> None:
        required = self.fmt.data_offset + self.fmt.total_records * self.fmt.record_size
        if len(self.data) < required:
            raise ValueError(
                f"PLR 文件长度不足：实际 {len(self.data)} 字节，至少需要 {required} 字节"
            )

    def _offset(self, record_index: int, field_index: int) -> int:
        if record_index < 0 or record_index >= self.fmt.total_records:
            raise IndexError(f"record_index 越界：{record_index}")
        if field_index < 0 or field_index * 2 + 2 > self.fmt.record_size:
            raise IndexError(f"field_index 越界：{field_index}")
        return self.fmt.data_offset + record_index * self.fmt.record_size + field_index * 2

    def read_raw(self, record_index: int, field_index: int) -> int:
        return struct.unpack_from("<h", self.data, self._offset(record_index, field_index))[0]

    def write_raw(self, record_index: int, field_index: int, value: int) -> int:
        clipped = max(INT16_MIN, min(INT16_MAX, int(value)))
        struct.pack_into("<h", self.data, self._offset(record_index, field_index), clipped)
        return clipped

    def save(self, output_path: str | Path) -> None:
        target = Path(output_path)
        if target.resolve() == self.path.resolve():
            raise ValueError("拒绝覆盖原始 PLR 文件，请指定新的 output 路径")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.data)
