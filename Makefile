SHELL := /bin/bash
export NEXT_TELEMETRY_DISABLED := 1
export TURBO_TELEMETRY_DISABLED := 1

# Scale knobs (override on the CLI: make gen APPS=2000 LIBS=300)
APPS ?= 200
LIBS ?= 100
MODULES ?= 16
APP ?= @demo/app-00100
SCALES ?= 300:100 1500:300

.PHONY: help gen gen-versioned install graph build typecheck typecheck-warm focus prune bench sweep chart comparison-chart deploy-vercel diamond per-app registry-resolution install-bench build-bench lockfile-bench lib-rev-bench clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

gen: ## Generate the workspace (APPS/LIBS/MODULES)
	node scripts/generate.mjs --apps $(APPS) --libs $(LIBS) --modules $(MODULES) --clean

install: ## Install the workspace
	pnpm install

graph: ## Print turbo task-graph size
	pnpm exec turbo run build --dry=json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("build tasks:",j.tasks.length)})'

build: ## Build everything (careful at 10k!)
	pnpm exec turbo run build

typecheck: ## Typecheck everything (cold)
	pnpm exec turbo run typecheck

typecheck-warm: typecheck ## Typecheck twice to show warm cache
	pnpm exec turbo run typecheck

focus: ## Task-time focus: build one APP + its lib closure
	pnpm exec turbo run build --filter=$(APP)...

prune: ## Artifact-time focus: minimal subtree for one APP
	pnpm exec turbo prune $(APP) --docker

bench: ## Run the full benchmark at APPS/LIBS
	node scripts/measure.mjs --label $(APPS)x$(LIBS) --apps $(APPS) --libs $(LIBS) --modules $(MODULES) --fs-stats

chart: ## Render charts from bench/results.json
	node scripts/chart.mjs

comparison-chart: ## Render the tool head-to-head heatmap SVG + high-res PNG from the comparison benches
	node scripts/comparison-chart.mjs

gen-versioned: ## Generate with semver versions + workspace:^x.y.z specifiers
	node scripts/generate.mjs --apps $(APPS) --libs $(LIBS) --modules $(MODULES) --versioned --clean

sweep: ## Run the full scaling sweep (200 -> 20k) -> bench/results.json
	node scripts/sweep.mjs

deploy-vercel: ## Deploy APP to Vercel (pruned subtree, cloud build) + time it
	node scripts/deploy-vercel.mjs --app $(APP) --prod

diamond: ## Publish to CodeArtifact + show diamond deps + workspace override collapse
	bash scripts/diamond-demo.sh

per-app: ## Per-app workspaces: transitive per-app divergence + workspace:^ pack rewrite (live, CodeArtifact)
	bash scripts/per-app-workspace-demo.sh

registry-resolution: ## Resolution cases a/b/c: registry vs override vs workspace:* (live, CodeArtifact)
	bash scripts/registry-resolution-demo.sh

# no SCALES passthrough: the script's own default is the canonical scale matrix the docs
# and the comparison chart cite; any other scales write install-bench.partial.json
install-bench: ## pnpm (isolated+hoisted) vs bun vs yarn 4 (nm+PnP) install at the canonical scales
	node scripts/install-bench.mjs

build-bench: ## full Next vs Vite build at APPS/LIBS
	node scripts/build-bench.mjs $(APPS) $(LIBS)

lockfile-bench: ## decompose install: resolve (--lockfile-only) vs verify vs full, per SCALES
	node scripts/lockfile-bench.mjs "$(SCALES)"

lib-rev-bench: ## rev a universal lib: workspace-dep vs npm-dep cost, tsc vs tsgo (APPS:LIBS)
	node scripts/lib-rev-bench.mjs $(APPS):$(LIBS)

clean: ## Reset worktree: restore patched tracked files, wipe generated tree + bench scratch (add KILL=1 to stop strays)
	node scripts/clean-state.mjs --wipe $(if $(KILL),--kill,)
	rm -rf examples/diamond
