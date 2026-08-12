import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HudStats, HudUsageScope } from "./types.ts";

export const TOOL_ORDER = ["edit", "write", "bash", "read", "grep", "find", "ls"];

type UsageTotals = Pick<HudStats, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;

function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

function timestampToMs(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(value: unknown): UsageTotals | undefined {
	if (!isRecord(value)) return undefined;
	return {
		input: numericValue(value.input),
		output: numericValue(value.output),
		cacheRead: numericValue(value.cacheRead),
		cacheWrite: numericValue(value.cacheWrite),
		cost: isRecord(value.cost) ? numericValue(value.cost.total) : 0,
	};
}

function addUsage(total: UsageTotals, usage: UsageTotals): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.cost += usage.cost;
}

function collectBranchStats(entries: SessionEntry[]): HudStats {
	const stats: HudStats = {
		...createUsageTotals(),
		tools: new Map(),
	};

	for (const entry of entries) {
		const entryTime = timestampToMs((entry as { timestamp?: unknown }).timestamp);
		if (entryTime !== undefined) stats.startedAt = Math.min(stats.startedAt ?? entryTime, entryTime);

		if (entry.type !== "message") continue;
		const message: unknown = entry.message;
		if (!isRecord(message)) continue;

		if (message.role === "assistant") {
			const usage = normalizeUsage(message.usage);
			if (!usage) continue;
			addUsage(stats, usage);
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			stats.latestCacheHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens : undefined;
			continue;
		}

		if (message.role === "toolResult" && typeof message.toolName === "string") {
			const current = stats.tools.get(message.toolName) ?? { ok: 0, error: 0 };
			if (message.isError) current.error++;
			else current.ok++;
			stats.tools.set(message.toolName, current);
		}
	}

	return stats;
}

function collectSessionUsage(entries: SessionEntry[]): UsageTotals {
	const total = createUsageTotals();

	for (const entry of entries) {
		let usage: UsageTotals | undefined;

		if (entry.type === "message") {
			const message: unknown = entry.message;
			if (isRecord(message) && (message.role === "assistant" || message.role === "toolResult")) {
				usage = normalizeUsage(message.usage);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = normalizeUsage((entry as unknown as Record<string, unknown>).usage);
		}

		if (usage) addUsage(total, usage);
	}

	return total;
}

export function collectStats(ctx: ExtensionContext, usageScope: HudUsageScope): HudStats {
	const branchStats = collectBranchStats(ctx.sessionManager.getBranch());
	if (usageScope === "branch") return branchStats;

	return {
		...branchStats,
		...collectSessionUsage(ctx.sessionManager.getEntries()),
	};
}
