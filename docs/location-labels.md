# Location label contract

The client should prefer `location_label` over a bare station field. This preserves the source state instead of reducing position to one station name.

| Source state | Public label |
| --- | --- |
| origin train published before scheduled departure | `XX 운행 대기` |
| arrival | `XX 도착` |
| departure | `XX 출발` |
| approach / previous-station departure | `XX-YY` |
| timetable projection between timed stops | `XX-YY` |
