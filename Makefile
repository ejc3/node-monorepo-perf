SHELL := /bin/bash
export NEXT_TELEMETRY_DISABLED := 1
export TURBO_TELEMETRY_DISABLED := 1

# Scale knobs (override on the CLI: make gen APPS=2000 LIBS=300)
APPS ?= 200
LIBS ?= 100
MODULES ?= 16
APP ?= @demo/app-00100

.PHONY: help gen install graph build typecheck typecheck-warm focus prune bench chart clean

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

clean: ## Remove generated workspace + caches
	rm -rf apps packages out .turbo node_modules/.cache/turbo
