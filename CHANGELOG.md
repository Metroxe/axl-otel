# Changelog

## [0.2.0](https://github.com/Metroxe/axl-otel/compare/v0.1.0...v0.2.0) (2026-05-03)


### Features

* **editor:** add request history with trace links ([d413626](https://github.com/Metroxe/axl-otel/commit/d4136262c78e31065553abbfbcf99b7ff4896dab))
* **editor:** tighten rate limit and add IP whitelist ([4f2668f](https://github.com/Metroxe/axl-otel/commit/4f2668f34e1b278864b128a9aeb17ea699b47763))
* **editor:** wire rate limiter into POST /run ([072c0f9](https://github.com/Metroxe/axl-otel/commit/072c0f96b8dbc04f880b6ed022d4789e66ccbc62))
* **example:** add broken-mode compose override ([d3a3daf](https://github.com/Metroxe/axl-otel/commit/d3a3daf443703e136e32401de5fdb2f62f0b8802))
* **example:** add favicons and animated og:image for editor ([0991151](https://github.com/Metroxe/axl-otel/commit/099115198b6f954222a57fd33b8b1185b7a36df1))
* **example:** add run timeouts, streaming Claude spans, and trace-ready polling ([63b92f5](https://github.com/Metroxe/axl-otel/commit/63b92f5120a3005960391634f6174146e6c372b0))
* **example:** visualise mesh on Editor page with per-node outputs ([fb1397d](https://github.com/Metroxe/axl-otel/commit/fb1397d596c5cdfdae62630eb99c06435d52973a))


### Bug Fixes

* **ci:** derive tag from manifest instead of action output ([2db49b2](https://github.com/Metroxe/axl-otel/commit/2db49b2d7ced4853da96af0a7a7186dcb8773434))
* **example:** let leaf peer error messages win over JSON-RPC wraps ([40e9b81](https://github.com/Metroxe/axl-otel/commit/40e9b81feb3a472eefbf77e867fa2af0cc92642c))
* **example:** pin twitter:image to PNG for predictable card rendering ([888f9a9](https://github.com/Metroxe/axl-otel/commit/888f9a99bf481f2692f23d385e359b5023b14446))


### Performance

* **example:** compile sidecar + agent with explicit baseline target ([51ce9b9](https://github.com/Metroxe/axl-otel/commit/51ce9b99c1c21bfab0d31bc6ab643f0e6042b054))
* **example:** compile sidecar to native binary in agent images ([4e8cf36](https://github.com/Metroxe/axl-otel/commit/4e8cf36b51c2b3d37fd49606e8d71eeebba71462))
* **example:** run sidecar + agent bun procs with --smol ([f9d9c2e](https://github.com/Metroxe/axl-otel/commit/f9d9c2e15ded467f7a8a33ba543d76e5e2ba6eb4))


### Refactors

* **sidecar:** rename --jaeger-url to --otlp-url ([bba4015](https://github.com/Metroxe/axl-otel/commit/bba40158c025c3709bb41a16650bfdf90653ee3e))


### Documentation

* add project README ([540fe5d](https://github.com/Metroxe/axl-otel/commit/540fe5d97b04923fed4d37cec11a66dd764493c6))
* add README assets ([a4e6b3a](https://github.com/Metroxe/axl-otel/commit/a4e6b3a6a0e394f5e50d976d9f83388e3ee948aa))
* **assets:** add static PNG panel alternatives for submission ([79cf1ca](https://github.com/Metroxe/axl-otel/commit/79cf1ca23b5a34b44a50a90349d69e78fb308c39))
* **example:** explain demo intent and surface intentional errors ([a3522ba](https://github.com/Metroxe/axl-otel/commit/a3522bae2d3a574214e74adbe32994c78fed36f1))
* **example:** lead the About modal with what axl-otel actually is ([e19876e](https://github.com/Metroxe/axl-otel/commit/e19876ecdd4ae96adaea4026d85e25c3c64ba7c6))
* **example:** rewrite the demo's About modal to teach what's running ([d2c9337](https://github.com/Metroxe/axl-otel/commit/d2c9337705cc584d39ea1624d474840176abfff2))
* link README demo to hosted instance ([72c7e15](https://github.com/Metroxe/axl-otel/commit/72c7e1557c566623e75787672b7fdbacc86b0c1f))
* **readme:** point cover image at cover-hires.gif ([7d4072f](https://github.com/Metroxe/axl-otel/commit/7d4072f396bed5c7870a0d7c20f9ee3c324bafd1))
* **readme:** use high-resolution gif assets ([f81c4df](https://github.com/Metroxe/axl-otel/commit/f81c4dfea10ecb1a790c6ed4306c0e9e5b6f44ef))


### Build

* **example:** pin all images to linux/arm64 ([5f356d3](https://github.com/Metroxe/axl-otel/commit/5f356d3dd46f0b3da6947dc975816f88f0f523ee))


### Chores

* **assets:** split assets into logo/ and panels/ subfolders ([09f13fc](https://github.com/Metroxe/axl-otel/commit/09f13fc1553a370b341e522f09c1f27a123b5ae3))
* drop release-as override now that v0.1.0 has shipped ([a2380e0](https://github.com/Metroxe/axl-otel/commit/a2380e0bcebff981be92adf2ae889a01765860e8))
* ignore Claude Code local skill and scheduler artifacts ([bc77c8d](https://github.com/Metroxe/axl-otel/commit/bc77c8db1abe51db894743adac8e1d73fb84251c))
* **sidecar:** log span counts on inbound callback delivery ([4e58409](https://github.com/Metroxe/axl-otel/commit/4e584091502ce2c2d9f75174d06b7996b915db07))

## 0.1.0 (2026-05-01)


### Features

* **editor:** emit a span on page load ([f74e72e](https://github.com/Metroxe/axl-otel/commit/f74e72e281d67cbc579085de68bfd64489961fec))
* **editor:** emit a startup span so it shows in Jaeger immediately ([500629d](https://github.com/Metroxe/axl-otel/commit/500629da691772f8247f9c698fff6d20354ea84e))
* **editor:** move output to dedicated section ([b81aec1](https://github.com/Metroxe/axl-otel/commit/b81aec17015202275b9613a08ac688eade3efc7b))
* **editor:** show target peer prominently in mesh activity ([4d837e4](https://github.com/Metroxe/axl-otel/commit/4d837e4c997f2caf944f9f30c4b063fa81e3e109))
* **example:** add Citation-DB MCP server (leaf agent) ([179242a](https://github.com/Metroxe/axl-otel/commit/179242a033d5ff7d226b1c93738fbd94952f6624))
* **example:** add Fact-Checker MCP agent (calls Citation-DB) ([842c88c](https://github.com/Metroxe/axl-otel/commit/842c88cf256ca5c856248c46561af0fcd58fc917))
* **example:** add Researcher MCP agent (calls Web-Search) ([0953307](https://github.com/Metroxe/axl-otel/commit/0953307294a177ee8dc8e1c2c8369816911287df))
* **example:** add Web-Search MCP server (leaf agent) ([56535b4](https://github.com/Metroxe/axl-otel/commit/56535b41ead73378549b3fefd6f3eeaf65727aab))
* **example:** flesh out Editor with Claude orchestrator + frontend ([5086470](https://github.com/Metroxe/axl-otel/commit/50864708144c0c3af55dafbfe6e5c54667076add))
* **example:** scaffold editor agent with AXL connectivity ([89f7bd9](https://github.com/Metroxe/axl-otel/commit/89f7bd97bb47426c5eb2111d09e0511a507808fb))
* **example:** tighten topology to spec's trust model ([f9689f5](https://github.com/Metroxe/axl-otel/commit/f9689f59b80eac2b665d494c57da2e51ee210d49))
* **example:** wire up 5-agent mesh infra (compose, keys, configs) ([5313ddd](https://github.com/Metroxe/axl-otel/commit/5313ddd14f3ab39582edc603e49e7bd12421256f))
* **sidecar:** cap OTLP request body at 4 MiB ([02c1316](https://github.com/Metroxe/axl-otel/commit/02c13169a18fe156ec3f5c695826d4e1f40ab9ea))
* **sidecar:** clearer 415, 404, and 405 responses ([e27bb66](https://github.com/Metroxe/axl-otel/commit/e27bb661129b8c6c2057e513a021d544e1bd2327))
* **sidecar:** drain receiver and poller on SIGTERM/SIGINT ([e9d8326](https://github.com/Metroxe/axl-otel/commit/e9d83266571f517d1e2b0e450df79cefcfe49c90))
* **sidecar:** report rejectedSpans for Jaeger and AXL /send failures ([81605cf](https://github.com/Metroxe/axl-otel/commit/81605cf3b478cbabef8f69b3827d6bdbb64aa141))
* **sidecar:** scaffold bun + typescript sidecar ([5d75b8c](https://github.com/Metroxe/axl-otel/commit/5d75b8c39e673aaef215dbf3f88cbcb2e900f012))


### Bug Fixes

* **ci:** treat repo root as the release-please package ([075676e](https://github.com/Metroxe/axl-otel/commit/075676e82a55d4f3c6043b4e0690ebc57aee1ae9))
* **ci:** wire up build jobs and move CHANGELOG to repo root ([03ee0e3](https://github.com/Metroxe/axl-otel/commit/03ee0e31b2900f82d999009be43bc4907cf7c6ce))
* **example:** enable AXL MCP Router + raise editor idleTimeout ([ea3f6c2](https://github.com/Metroxe/axl-otel/commit/ea3f6c25056cbc6d017a2807a4b9c15fcff2146a))
* **sidecar:** align with actual AXL HTTP API shape ([00e063a](https://github.com/Metroxe/axl-otel/commit/00e063a468ed0ff3a7ed0bf314769de5e15d3cb4))


### Refactors

* **sidecar:** replace parseArgs with commander ([177e808](https://github.com/Metroxe/axl-otel/commit/177e8083f1dfacb02a696e3d947175f7eb43fb54))
* **sidecar:** validate AXL responses with zod ([07a109d](https://github.com/Metroxe/axl-otel/commit/07a109d834ce8c11e7b88ca73cb350469582cd6a))


### Documentation

* drop hello-world from spec layout ([732283c](https://github.com/Metroxe/axl-otel/commit/732283cdc1cc054a2e64f870a60e52385b5110fe))
* **example:** add README and .env-based secrets handling ([61c0841](https://github.com/Metroxe/axl-otel/commit/61c0841d571a88498db4ebfcf1a905f96487ea4f))


### CI

* add release-please workflow ([57e509b](https://github.com/Metroxe/axl-otel/commit/57e509bc4d209c60345c8857b0467991d251222d))


### Tests

* **sidecar:** cover routeSpans local/remote splitting ([3656bbe](https://github.com/Metroxe/axl-otel/commit/3656bbe92bcf97e6211686f4e64aabe904b34fdd))


### Chores

* add root .gitignore ([ce44fb3](https://github.com/Metroxe/axl-otel/commit/ce44fb375b679d6e0c3ebfb41aa53346bb9449be))
* add spec ([6ddbe7a](https://github.com/Metroxe/axl-otel/commit/6ddbe7ac8f9bb3d1909e39b00dfbf9a576f89098))
* gitignore Claude Code local settings ([6991cc7](https://github.com/Metroxe/axl-otel/commit/6991cc78e3fcda25676520fb172614cac2609270))
* ignore video/ working directory ([0d127fb](https://github.com/Metroxe/axl-otel/commit/0d127fbbbb6d13f77bda1e619211106dd924ae91))
* **main:** release 0.1.0 ([e16524f](https://github.com/Metroxe/axl-otel/commit/e16524f000e675dd948be63f2430e6d3f15e206a))
* **main:** release 0.1.0 ([e16524f](https://github.com/Metroxe/axl-otel/commit/e16524f000e675dd948be63f2430e6d3f15e206a))
* **main:** release 0.1.0 ([2b91729](https://github.com/Metroxe/axl-otel/commit/2b917293457e5a78fa49c80f59f702f93af1209d))
* pin first release to 0.1.0 ([c7cab94](https://github.com/Metroxe/axl-otel/commit/c7cab94d9574b7707bca199615e952222ed72981))
* prepare to re-cut v0.1.0 with full artifacts ([f5c4b1e](https://github.com/Metroxe/axl-otel/commit/f5c4b1e84df29c921a72923406694063ac69c3ff))
