# Realtime progress semantics

## Position labels

Realtime position rows are rendered at the granularity the source exposes instead of collapsing everything to one station name.

- station arrival: `XX 도착`
- station departure: `XX 출발`
- approaching / previous-station-departed state: `XX-YY`
- a train already visible at its origin but whose scheduled departure is still in the future: `XX 운행 대기`

Estimated, non-live positions use the same compact `XX-YY` convention between timed stops.

## Delay safety

A negative delay at a terminal can be produced when the realtime API publishes a train before its scheduled first departure. That state is not treated as early running. It is classified as `운행 대기` and contributes zero delay.

Other implausible delay observations are replaced by a fail-safe estimate based on the nearest scheduled train ahead and behind on the same line/direction. When both sides are available their delay seconds are averaged; when only one side is available that neighbor is used. A same-direction median is retained only as the last fallback when neither neighbor exists.

## Journey progression

After explicit boarding, the client polls trip updates and advances ride → transfer → waiting → ride automatically. Transfer completion is also driven by a local one-second countdown so the UI can show remaining transfer time continuously without increasing realtime API traffic.
