# Changelog

## 0.1.0 (2026-05-01)


### Features

* **sidecar:** cap OTLP request body at 4 MiB ([02c1316](https://github.com/Metroxe/axl-otel/commit/02c13169a18fe156ec3f5c695826d4e1f40ab9ea))
* **sidecar:** clearer 415, 404, and 405 responses ([e27bb66](https://github.com/Metroxe/axl-otel/commit/e27bb661129b8c6c2057e513a021d544e1bd2327))
* **sidecar:** drain receiver and poller on SIGTERM/SIGINT ([e9d8326](https://github.com/Metroxe/axl-otel/commit/e9d83266571f517d1e2b0e450df79cefcfe49c90))
* **sidecar:** report rejectedSpans for Jaeger and AXL /send failures ([81605cf](https://github.com/Metroxe/axl-otel/commit/81605cf3b478cbabef8f69b3827d6bdbb64aa141))
* **sidecar:** scaffold bun + typescript sidecar ([5d75b8c](https://github.com/Metroxe/axl-otel/commit/5d75b8c39e673aaef215dbf3f88cbcb2e900f012))


### Bug Fixes

* **sidecar:** align with actual AXL HTTP API shape ([00e063a](https://github.com/Metroxe/axl-otel/commit/00e063a468ed0ff3a7ed0bf314769de5e15d3cb4))


### Refactors

* **sidecar:** replace parseArgs with commander ([177e808](https://github.com/Metroxe/axl-otel/commit/177e8083f1dfacb02a696e3d947175f7eb43fb54))
* **sidecar:** validate AXL responses with zod ([07a109d](https://github.com/Metroxe/axl-otel/commit/07a109d834ce8c11e7b88ca73cb350469582cd6a))


### Tests

* **sidecar:** cover routeSpans local/remote splitting ([3656bbe](https://github.com/Metroxe/axl-otel/commit/3656bbe92bcf97e6211686f4e64aabe904b34fdd))
