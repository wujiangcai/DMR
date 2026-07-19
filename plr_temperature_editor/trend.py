from __future__ import annotations


def clamp(value: float, minimum: float | None = None, maximum: float | None = None) -> float:
    if minimum is not None and value < minimum:
        return minimum
    if maximum is not None and value > maximum:
        return maximum
    return value


def moving_average(values: list[float | None], window: int) -> list[float | None]:
    if window <= 0:
        raise ValueError("smooth_window 必须大于 0")
    radius = window // 2
    result: list[float | None] = []
    for index, value in enumerate(values):
        if value is None:
            result.append(None)
            continue
        start = max(0, index - radius)
        end = min(len(values), index + radius + 1)
        samples = [item for item in values[start:end] if item is not None]
        result.append(sum(samples) / len(samples) if samples else None)
    return result
