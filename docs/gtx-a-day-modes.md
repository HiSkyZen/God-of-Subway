# GTX-A service-day modes

The routing contract retains three resolved service modes: `DAY` (weekday), `SAT` (Saturday), and `END` (Sunday/holiday). The GTX-A source export reviewed for this change publishes two timetable classes, `평일` and `주말`. Therefore `DAY` reads the weekday table, while `SAT` and `END` are separately routed mode keys backed by the published weekend table. They are intentionally not collapsed in the API or routing model, so a distinct Saturday or Sunday/holiday source can replace either table independently if the operator publishes one.
