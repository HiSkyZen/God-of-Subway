# Journey state machine

The live client state machine is `ride → transfer → waiting → ride`, ending at `done`. Ride completion is driven by realtime arrival/remaining-time updates; transfer completion is driven by the configured transfer duration and automatically re-enters the route calculation for the next leg.
