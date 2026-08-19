# Client location priority

For route and live-trip displays, the client prefers the backend `location_label` field, then falls back to current-station fields. This keeps arrival/departure/between-station/waiting semantics visible whenever the realtime source can provide them.
