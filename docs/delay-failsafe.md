# Delay fail-safe

Realtime observations at a terminal are not interpreted as early running merely because the API starts publishing the train before its first scheduled departure. Such rows are `운행 대기` with zero delay until the scheduled departure.

For an observation whose timetable offset is outside the accepted range, delay is reconstructed from the nearest valid train ahead and behind in the same direction. The two delay values are averaged when both are present. One-sided neighbor data is used when only one side is available; only if neither neighbor exists does the engine fall back to the same-direction/service median.
