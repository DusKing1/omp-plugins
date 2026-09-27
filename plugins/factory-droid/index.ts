/*
 * MIT License — adapted portions from oh-my-pi:
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Factory Droid provider plugin for oh-my-pi (omp). Install: see README.md.
// Registry/routing adapted from @will-bogusz's native provider (can1357/oh-my-pi#8577,
// continued in #13276), MIT. Then /login factory-droid and /model factory-droid/…
import { createHash, randomUUID } from "node:crypto";
import * as AI from "@oh-my-pi/pi-ai";
import type {
	AnthropicOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	GoogleOptions,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OpenAICompletionsOptions,
	OpenAIResponsesOptions,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
const PROVIDER = "factory-droid";
const API = "factory-droid-local";
const VERSION = "0.228.0";
const IDENTITY =
	"You are Droid, an AI software engineering agent built by Factory.";
function apiHost(region?: string): string {
	return region === "eu"
		? "https://api.eu.factory.ai"
		: "https://api.factory.ai";
}
function unpackCredential(key: string): { access: string; region?: string } {
	const value = key.startsWith("{") ? JSON.parse(key) : { access: key };
	if (
		!value ||
		typeof value.access !== "string" ||
		!value.access.trim() ||
		value.access === "N/A"
	)
		throw new Error("Run /login factory-droid first");
	return {
		access: value.access,
		region: value.region === "eu" ? "eu" : undefined,
	};
}

type FetchImpl = NonNullable<OAuthLoginCallbacks["fetch"]>;

const WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
const WORKOS_DEVICE_URL =
	"https://api.workos.com/user_management/authorize/device";
const WORKOS_TOKEN_URL = "https://api.workos.com/user_management/authenticate";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonempty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Factory authorization cancelled");
}

async function workosPost(
	url: string,
	params: Record<string, string>,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
	deadlineSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
	cancelled(signal);
	const timeout = AbortSignal.timeout(15_000);
	const combined = AbortSignal.any([
		timeout,
		...(signal ? [signal] : []),
		...(deadlineSignal ? [deadlineSignal] : []),
	]);
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params).toString(),
			signal: combined,
		});
		return {
			ok: response.ok,
			status: response.status,
			body: record(await response.json()) ?? {},
		};
	} catch {
		cancelled(signal);
		if (deadlineSignal?.aborted)
			throw new Error("Factory device code expired; restart login");
		if (timeout.aborted)
			throw new Error("Factory authorization request timed out");
		throw new Error("Factory authorization request failed");
	}
}

function tokenClaims(access: string): Record<string, unknown> | undefined {
	const parts = access.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		return record(
			JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
		);
	} catch {
		return undefined;
	}
}

async function factoryRegion(
	access: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	cancelled(signal);
	const timeout = AbortSignal.timeout(15_000);
	try {
		const response = await fetchImpl(`${apiHost(undefined)}/api/cli/whoami`, {
			headers: {
				Authorization: `Bearer ${access}`,
				Accept: "application/json",
			},
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (response.ok) {
			const region = nonempty(record(await response.json())?.region);
			cancelled(signal);
			return region;
		}
	} catch {
		cancelled(signal);
		// Unavailable residency lookup leaves the previously stored region intact on refresh.
	}
	cancelled(signal);
	return undefined;
}

async function factoryCredentials(
	body: Record<string, unknown>,
	fetchImpl: FetchImpl,
	previous?: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const access = nonempty(body.access_token);
	const refresh = nonempty(body.refresh_token) ?? previous?.refresh;
	if (!access || !refresh)
		throw new Error("Factory token response missing credentials");
	const claims = tokenClaims(access);
	const exp = claims?.exp;
	const user = record(body.user);
	const credentials: OAuthCredentials = {
		...previous,
		access,
		refresh,
		expires:
			typeof exp === "number" && Number.isFinite(exp)
				? exp * 1000
				: Date.now() + 86_400_000,
	};
	credentials.email =
		nonempty(user?.email) ?? nonempty(claims?.email) ?? previous?.email;
	credentials.accountId =
		nonempty(user?.id) ?? nonempty(claims?.sub) ?? previous?.accountId;
	// WorkOS organization_id is internal; only the access JWT's external_org_id is routable.
	credentials.orgId = nonempty(claims?.external_org_id) ?? previous?.orgId;
	const region = await factoryRegion(access, fetchImpl, signal);
	cancelled(signal);
	credentials.region = region ?? previous?.region;
	return credentials;
}

async function loginFactory(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const fetchImpl = callbacks.fetch ?? fetch;
	cancelled(callbacks.signal);
	callbacks.onProgress?.("Requesting device authorization...");
	const device = await workosPost(
		WORKOS_DEVICE_URL,
		{ client_id: WORKOS_CLIENT_ID },
		fetchImpl,
		callbacks.signal,
	);
	if (!device.ok)
		throw new Error(
			`Factory device authorization failed (HTTP ${device.status})`,
		);
	const deviceCode = nonempty(device.body.device_code);
	const userCode = nonempty(device.body.user_code);
	const verificationUri = nonempty(device.body.verification_uri);
	if (!deviceCode || !userCode || !verificationUri)
		throw new Error("Factory device authorization response incomplete");
	const duration = device.body.expires_in;
	if (
		typeof duration !== "number" ||
		!Number.isFinite(duration) ||
		duration <= 0
	) {
		throw new Error("Factory device authorization response missing expiry");
	}
	const deadline = Date.now() + duration * 1000;
	let interval =
		typeof device.body.interval === "number" &&
		Number.isFinite(device.body.interval)
			? Math.max(1_000, Math.floor(device.body.interval * 1_000))
			: 5_000;
	callbacks.onAuth({
		url: nonempty(device.body.verification_uri_complete) ?? verificationUri,
		instructions: `Enter code: ${userCode}`,
	});
	callbacks.onProgress?.("Waiting for device authorization...");
	while (Date.now() < deadline) {
		cancelled(callbacks.signal);
		const expiry = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
		const result = await workosPost(
			WORKOS_TOKEN_URL,
			{
				grant_type: DEVICE_GRANT,
				client_id: WORKOS_CLIENT_ID,
				device_code: deviceCode,
			},
			fetchImpl,
			callbacks.signal,
			expiry,
		);
		cancelled(callbacks.signal);
		if (Date.now() >= deadline) break;
		const error = nonempty(result.body.error);
		if (result.ok && !error)
			return factoryCredentials(
				result.body,
				fetchImpl,
				undefined,
				callbacks.signal,
			);
		if (error === "expired_token")
			throw new Error("Factory device code expired; restart login");
		if (error === "access_denied")
			throw new Error("Factory device authorization denied");
		if (error === "slow_down") interval += 5_000;
		else if (error !== "authorization_pending")
			throw new Error(
				`Factory device token request failed (HTTP ${result.status})`,
			);
		const wait = Math.min(interval, deadline - Date.now());
		if (wait > 0) {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Factory authorization cancelled"));
				};
				const timer = setTimeout(() => {
					callbacks.signal?.removeEventListener("abort", onAbort);
					resolve();
				}, wait);
				callbacks.signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	}
	cancelled(callbacks.signal);
	throw new Error("Factory device code expired; restart login");
}

async function refreshFactory(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials.refresh)
		throw new Error("Factory refresh token missing; sign in again");
	const result = await workosPost(
		WORKOS_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: WORKOS_CLIENT_ID,
			refresh_token: credentials.refresh,
		},
		fetch,
		signal,
	);
	if (!result.ok || nonempty(result.body.error))
		throw new Error(`Factory token refresh failed (HTTP ${result.status})`);
	return factoryCredentials(result.body, fetch, credentials, signal);
}

type Wire =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generate";
type Effort = NonNullable<SimpleStreamOptions["reasoning"]>;
type Entry = {
	id: string;
	name: string;
	wire: Wire;
	pool?: "core" | "standard";
	contextWindow: number;
	maxTokens: number;
	euContextWindow?: number;
	euMaxTokens?: number;
	apiProviders: string[];
	globalApiProviders?: string[];
	euApiProviders?: string[];
	credits?: { input: number; output?: number; cacheRead?: number };
	toolMessageIncludesName?: boolean;
	supportedReasoningEfforts?: string[];
	defaultReasoningEffort?: string;
	featureFlag?: string;
	deprecationFlag?: string;
	requiresExplicitOptIn?: boolean;
	baseVariant?: string;
	thinkingStyle?:
		| "adaptive"
		| "adaptive-summarized"
		| "budget-interleaved"
		| "budget-effort"
		| "budget-effort-beta";
	refusalFallbackModels?: string[];
	geminiMedium?: boolean;
	responsesConfig?: {
		verbosity?: "low";
		serviceTier?: "priority";
		parallelToolCalls?: boolean;
		extendedCache?: boolean;
		safetyId?: boolean;
	};
	completionsReasoning?: {
		fireworks?: { history: "preserved" | "interleaved" };
		baseten?: { mode: "opt-in" | "reasoning-effort" | "forced-on" };
	};
	reasoningReplay?: "capture-only" | "standard" | "placeholder";
	fastMode?: boolean;
	noImageSupport?: boolean;
	/** Raw API list price per million tokens, baked from priceRef at generation time; zero when no reference exists. */
	cost?: [number, number, number, number];
};

// Factory CLI 0.228.0 concrete picker entries, excluding hard-retired models.
// Price references have been resolved at generation time; there is no runtime catalog dependency.
// biome-ignore format: generated registry snapshot, one model per row
const ENTRIES: Entry[] = [
	{"id":"claude-fable-5.1","name":"Fable 5.1","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"euApiProviders":[],"credits":{"input":4,"output":5,"cacheRead":0.025},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","requiresExplicitOptIn":true,"thinkingStyle":"adaptive-summarized","refusalFallbackModels":["claude-opus-5"]},
	{"id":"claude-fable-5","name":"Fable 5","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"euApiProviders":[],"credits":{"input":4,"output":5},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","requiresExplicitOptIn":true,"thinkingStyle":"adaptive-summarized","refusalFallbackModels":["claude-opus-5"],"cost":[10,50,1,12.5]},
	{"id":"claude-opus-5-5","name":"Opus 5.5","wire":"anthropic-messages","contextWindow":872000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic","azure_anthropic"],"credits":{"input":1.6,"output":5,"cacheRead":0.05},"supportedReasoningEfforts":["low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","thinkingStyle":"adaptive-summarized","cost":[4,20,0.2,5]},
	{"id":"claude-opus-5-5-fast","name":"Opus 5.5 Fast Mode","wire":"anthropic-messages","contextWindow":872000,"maxTokens":128000,"apiProviders":["anthropic"],"credits":{"input":3.2,"output":5,"cacheRead":0.05},"supportedReasoningEfforts":["low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","featureFlag":"claude_opus_5_5_fast","baseVariant":"claude-opus-5-5","thinkingStyle":"adaptive-summarized","fastMode":true},
	{"id":"claude-opus-5","name":"Opus 5","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic","azure_anthropic","snowflake"],"euApiProviders":["bedrock_anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","thinkingStyle":"adaptive-summarized","cost":[5,25,0.5,6.25]},
	{"id":"claude-opus-5-fast","name":"Opus 5 Fast Mode","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic"],"credits":{"input":4},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","baseVariant":"claude-opus-5","thinkingStyle":"adaptive-summarized","fastMode":true},
	{"id":"claude-opus-4-8","name":"Opus 4.8","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"euApiProviders":["bedrock_anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","thinkingStyle":"adaptive-summarized","cost":[5,25,0.5,6.25]},
	{"id":"claude-opus-4-8-fast","name":"Opus 4.8 Fast Mode","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic"],"credits":{"input":4},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","baseVariant":"claude-opus-4-8","thinkingStyle":"adaptive-summarized","fastMode":true},
	{"id":"claude-opus-4-7","name":"Opus 4.7","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"euApiProviders":["bedrock_anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","thinkingStyle":"adaptive-summarized","cost":[5,25,0.5,6.25]},
	{"id":"claude-opus-4-6","name":"Opus 4.6","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high","max"],"defaultReasoningEffort":"high","thinkingStyle":"adaptive","cost":[5,25,0.5,6.25]},
	{"id":"claude-opus-4-5-20251101","name":"Opus 4.5","wire":"anthropic-messages","contextWindow":180000,"maxTokens":64000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high"],"defaultReasoningEffort":"off","thinkingStyle":"budget-effort-beta","cost":[5,25,0.5,6.25]},
	{"id":"claude-sonnet-5-5","name":"Sonnet 5.5","wire":"anthropic-messages","contextWindow":872000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic","azure_anthropic"],"credits":{"input":0.8,"output":5},"supportedReasoningEfforts":["low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","featureFlag":"claude_sonnet_5_5","thinkingStyle":"adaptive-summarized"},
	{"id":"claude-sonnet-5","name":"Sonnet 5","wire":"anthropic-messages","contextWindow":872000,"maxTokens":128000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"credits":{"input":0.8,"output":5},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","thinkingStyle":"adaptive-summarized","cost":[2,10,0.2,2.5]},
	{"id":"claude-sonnet-4-6","name":"Sonnet 4.6","wire":"anthropic-messages","contextWindow":931000,"maxTokens":64000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"credits":{"input":1.2},"supportedReasoningEfforts":["off","low","medium","high","max"],"defaultReasoningEffort":"high","thinkingStyle":"adaptive","cost":[3,15,0.3,3.75]},
	{"id":"claude-sonnet-4-5-20250929","name":"Sonnet 4.5","wire":"anthropic-messages","contextWindow":180000,"maxTokens":32000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"credits":{"input":1.2},"supportedReasoningEfforts":["off","low","medium","high"],"defaultReasoningEffort":"off","thinkingStyle":"budget-interleaved","cost":[3,15,0.3,3.75]},
	{"id":"claude-haiku-4-5-20251001","name":"Haiku 4.5","wire":"anthropic-messages","contextWindow":180000,"maxTokens":32000,"apiProviders":["anthropic","vertex_anthropic","bedrock_anthropic"],"credits":{"input":0.4},"supportedReasoningEfforts":["off","low","medium","high"],"defaultReasoningEffort":"off","thinkingStyle":"budget-interleaved","cost":[1,5,0.1,1.25]},
	{"id":"gpt-6-astra","name":"GPT-6 Astra","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai"],"euApiProviders":[],"credits":{"input":4,"output":5},"supportedReasoningEfforts":["low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[10,50,1,12.5]},
	{"id":"gpt-6-sol","name":"GPT-6 Sol","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai"],"credits":{"input":0.8,"output":5},"supportedReasoningEfforts":["none","low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","featureFlag":"gpt_6_sol","responsesConfig":{"parallelToolCalls":true,"extendedCache":true,"safetyId":true,"verbosity":"low"},"cost":[2,10,0.2,2.5]},
	{"id":"gpt-6-luna","name":"GPT-6 Luna","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai"],"credits":{"input":0.04,"output":5},"supportedReasoningEfforts":["none","low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","featureFlag":"gpt_6_luna","responsesConfig":{"parallelToolCalls":true,"extendedCache":true,"safetyId":true,"verbosity":"low"},"cost":[0.1,0.5,0.01,0.125]},
	{"id":"gpt-5.6-sol","name":"GPT-5.6 Sol","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","bedrock_openai","azure_openai","snowflake"],"euApiProviders":["openai"],"credits":{"input":2,"output":5},"supportedReasoningEfforts":["none","low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[4,20,0.4,5]},
	{"id":"gpt-5.6-sol-fast","name":"GPT-5.6 Sol Fast Mode","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":4,"output":5},"supportedReasoningEfforts":["none","low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","baseVariant":"gpt-5.6-sol","responsesConfig":{"verbosity":"low","serviceTier":"priority","parallelToolCalls":true,"extendedCache":true,"safetyId":true}},
	{"id":"gpt-5.6-terra","name":"GPT-5.6 Terra","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","bedrock_openai","azure_openai","snowflake"],"euApiProviders":["openai"],"credits":{"input":0.8,"output":6},"supportedReasoningEfforts":["none","low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[2,12,0.2,2.5]},
	{"id":"gpt-5.6-luna","name":"GPT-5.6 Luna","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","bedrock_openai","azure_openai","snowflake"],"euApiProviders":["openai"],"credits":{"input":0.08,"output":6},"supportedReasoningEfforts":["none","low","medium","high","xhigh","max"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[0.2,1.2,0.02,0.25]},
	{"id":"gpt-5.5","name":"GPT-5.5","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","bedrock_openai","azure_openai","snowflake"],"euApiProviders":["openai"],"credits":{"input":2,"output":6},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[5,30,0.5,0]},
	{"id":"gpt-5.5-fast","name":"GPT-5.5 Fast Mode","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":5,"output":6},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"medium","baseVariant":"gpt-5.5","responsesConfig":{"verbosity":"low","serviceTier":"priority","parallelToolCalls":true,"extendedCache":true,"safetyId":true}},
	{"id":"gpt-5.5-pro","name":"GPT-5.5 Pro","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai"],"credits":{"input":12,"output":6},"supportedReasoningEfforts":["medium","high","xhigh"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[30,180,0,0]},
	{"id":"gpt-5.4","name":"GPT-5.4","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","bedrock_openai","azure_openai"],"euApiProviders":["openai"],"credits":{"input":1,"output":6},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[2.5,15,0.25,0]},
	{"id":"gpt-5.4-fast","name":"GPT-5.4 Fast Mode","wire":"openai-responses","contextWindow":922000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":2,"output":6},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"medium","baseVariant":"gpt-5.4","responsesConfig":{"verbosity":"low","serviceTier":"priority","parallelToolCalls":true,"extendedCache":true,"safetyId":true}},
	{"id":"gpt-5.4-mini","name":"GPT-5.4 Mini","wire":"openai-responses","contextWindow":272000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":0.3,"output":6},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"high","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[0.75,4.5,0.075,0]},
	{"id":"gpt-5.4-mini-fast","name":"GPT-5.4 Mini Fast Mode","wire":"openai-responses","contextWindow":272000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":0.6,"output":6},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"high","baseVariant":"gpt-5.4-mini","responsesConfig":{"verbosity":"low","serviceTier":"priority","parallelToolCalls":true,"extendedCache":true,"safetyId":true}},
	{"id":"gpt-5.3-codex","name":"GPT-5.3-Codex","wire":"openai-responses","contextWindow":272000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":0.7},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"medium","responsesConfig":{"verbosity":"low","parallelToolCalls":true,"extendedCache":true,"safetyId":true},"cost":[1.75,14,0.175,0]},
	{"id":"gpt-5.3-codex-fast","name":"GPT-5.3-Codex Fast Mode","wire":"openai-responses","contextWindow":272000,"maxTokens":128000,"apiProviders":["openai"],"credits":{"input":1.4,"output":8},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"medium","baseVariant":"gpt-5.3-codex","responsesConfig":{"verbosity":"low","serviceTier":"priority","parallelToolCalls":true,"extendedCache":true,"safetyId":true}},
	{"id":"gpt-5.2","name":"GPT-5.2","wire":"openai-responses","contextWindow":272000,"maxTokens":128000,"apiProviders":["openai","azure_openai"],"credits":{"input":0.7},"supportedReasoningEfforts":["off","low","medium","high","xhigh"],"defaultReasoningEffort":"low","responsesConfig":{"verbosity":"low"},"cost":[1.75,14,0.175,0]},
	{"id":"garnet-07-15","name":"Garnet 07/15 (Preview)","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.6},"supportedReasoningEfforts":["medium","high"],"defaultReasoningEffort":"high","featureFlag":"garnet_0715"},
	{"id":"gemini-3.1-pro-preview","name":"Gemini 3.1 Pro","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.8},"supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"high","geminiMedium":true,"cost":[2,12,0.2,0]},
	{"id":"gemini-3.8-flash","name":"Gemini 3.8 Flash","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.6,"output":5},"supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"high","geminiMedium":true,"cost":[0.75,3.75,0.075,0]},
	{"id":"gemini-3.7-flash","name":"Gemini 3.7 Flash","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.6,"output":5},"supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"high","geminiMedium":true,"cost":[0.75,3.75,0.075,0]},
	{"id":"gemini-3.6-flash","name":"Gemini 3.6 Flash","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.6,"output":5},"supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"high","cost":[0.75,3.75,0.075,0]},
	{"id":"gemini-3.5-flash","name":"Gemini 3.5 Flash","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.6},"supportedReasoningEfforts":["minimal","low","medium","high"],"defaultReasoningEffort":"high","cost":[1.5,9,0.15,0]},
	{"id":"gemini-3-flash-preview","name":"Gemini 3 Flash","wire":"google-generate","contextWindow":1000000,"maxTokens":65536,"apiProviders":["google"],"credits":{"input":0.2},"supportedReasoningEfforts":["minimal","low","medium","high"],"defaultReasoningEffort":"high","cost":[0.5,3,0.05,0]},
	{"id":"inkling","name":"Inkling","wire":"openai-completions","pool":"core","contextWindow":1007232,"maxTokens":32768,"apiProviders":["fireworks"],"credits":{"input":0.4,"output":4.05,"cacheRead":0.17},"supportedReasoningEfforts":["off","minimal","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","reasoningReplay":"capture-only","completionsReasoning":{"fireworks":{"history":"preserved"}},"cost":[1.25,5.0625,0.2125,0]},
	{"id":"mistral-medium-3.5","name":"Mistral Medium 3.5","wire":"openai-completions","pool":"core","contextWindow":192000,"maxTokens":64000,"apiProviders":["mistral"],"euApiProviders":["mistral"],"credits":{"input":0.6,"output":5},"supportedReasoningEfforts":["off","high"],"defaultReasoningEffort":"high","reasoningReplay":"standard"},
	{"id":"glm-5.3-flash","name":"GLM-5.3-Flash","wire":"openai-completions","pool":"core","contextWindow":917504,"maxTokens":131072,"apiProviders":["fireworks","baseten"],"credits":{"input":0.06,"output":3.34,"cacheRead":0.2},"supportedReasoningEfforts":["low","high","max"],"defaultReasoningEffort":"high","completionsReasoning":{"fireworks":{"history":"preserved"},"baseten":{"mode":"reasoning-effort"}},"reasoningReplay":"standard","noImageSupport":true,"cost":[0.15,0.5,0.03,0]},
	{"id":"glm-5.3","name":"GLM-5.3","wire":"openai-completions","pool":"core","contextWindow":908928,"maxTokens":131072,"apiProviders":["fireworks","baseten","mistral"],"euApiProviders":["mistral"],"credits":{"input":0.56,"output":3.15},"supportedReasoningEfforts":["low","high","max"],"defaultReasoningEffort":"max","completionsReasoning":{"fireworks":{"history":"preserved"},"baseten":{"mode":"reasoning-effort"}},"reasoningReplay":"standard","noImageSupport":true,"globalApiProviders":["fireworks","baseten"],"cost":[1.4,4.4,0.26,0]},
	{"id":"glm-5.2","name":"GLM-5.2","wire":"openai-completions","pool":"core","contextWindow":908928,"maxTokens":131072,"apiProviders":["baseten","mistral"],"euApiProviders":["mistral","baseten"],"euContextWindow":200000,"euMaxTokens":65536,"credits":{"input":0.56,"output":3.15},"supportedReasoningEfforts":["off","high","max"],"defaultReasoningEffort":"high","completionsReasoning":{"baseten":{"mode":"reasoning-effort"}},"reasoningReplay":"standard","noImageSupport":true,"globalApiProviders":["baseten"],"cost":[1.4,4.4,0.26,0]},
	{"id":"glm-5.2-fast","name":"GLM-5.2 Fast","wire":"openai-completions","pool":"core","contextWindow":393216,"maxTokens":131072,"apiProviders":["baseten"],"credits":{"input":0.84,"output":3.2},"supportedReasoningEfforts":["off","high","max"],"defaultReasoningEffort":"high","featureFlag":"glm_5_2_fast","baseVariant":"glm-5.2","completionsReasoning":{"baseten":{"mode":"reasoning-effort"}},"reasoningReplay":"standard","noImageSupport":true},
	{"id":"kimi-k3","name":"Kimi K3","wire":"openai-completions","pool":"core","contextWindow":196608,"maxTokens":65536,"apiProviders":["fireworks","baseten"],"credits":{"input":1.2,"output":5},"toolMessageIncludesName":true,"supportedReasoningEfforts":["off","low","high","max"],"defaultReasoningEffort":"high","completionsReasoning":{"fireworks":{"history":"preserved"},"baseten":{"mode":"reasoning-effort"}},"reasoningReplay":"capture-only","cost":[3,15,0.3,0]},
	{"id":"qwen3.8-max","name":"Qwen3.8 Max","wire":"openai-completions","pool":"core","contextWindow":131072,"maxTokens":131072,"apiProviders":["fireworks"],"credits":{"input":0.8,"output":3},"supportedReasoningEfforts":["low","medium","xhigh"],"defaultReasoningEffort":"xhigh","noImageSupport":true,"reasoningReplay":"capture-only","completionsReasoning":{"fireworks":{"history":"preserved"}},"cost":[2,6,0.25,2.5]},
	{"id":"nemotron-3-ultra","name":"Nemotron 3 Ultra","wire":"openai-completions","pool":"core","contextWindow":136464,"maxTokens":65536,"apiProviders":["baseten","fireworks"],"credits":{"input":0.24,"output":4},"supportedReasoningEfforts":["off","high"],"defaultReasoningEffort":"high","completionsReasoning":{"fireworks":{"history":"preserved"},"baseten":{"mode":"opt-in"}},"reasoningReplay":"standard","noImageSupport":true,"cost":[0.6,2.4,0.12,0]},
	{"id":"deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","wire":"openai-completions","pool":"core","contextWindow":908928,"maxTokens":131072,"apiProviders":["fireworks","baseten"],"credits":{"input":0.12,"output":4,"cacheRead":0.1},"supportedReasoningEfforts":["off","low","high","max"],"defaultReasoningEffort":"high","featureFlag":"deepseek_v4_1_flash","completionsReasoning":{"fireworks":{"history":"interleaved"},"baseten":{"mode":"forced-on"}},"reasoningReplay":"placeholder","cost":[0.15,0.6,0.003,0]},
	{"id":"deepseek-v4-flash-0731","name":"DeepSeek V4 Flash 0731","wire":"openai-completions","pool":"core","contextWindow":908928,"maxTokens":131072,"apiProviders":["fireworks","baseten"],"credits":{"input":0.176,"output":3,"cacheRead":0.032},"supportedReasoningEfforts":["off","low","high","max"],"defaultReasoningEffort":"high","deprecationFlag":"deprecate_deepseek_v4_flash_0731","completionsReasoning":{"fireworks":{"history":"interleaved"},"baseten":{"mode":"forced-on"}},"reasoningReplay":"placeholder","noImageSupport":true,"cost":[0.175,0.35,0.035,0]},
	{"id":"deepseek-v4-pro","name":"DeepSeek V4 Pro","wire":"openai-completions","pool":"core","contextWindow":908928,"maxTokens":131072,"apiProviders":["fireworks","baseten"],"credits":{"input":0.528,"output":3,"cacheRead":0.034},"supportedReasoningEfforts":["off","low","high","max"],"defaultReasoningEffort":"high","deprecationFlag":"deprecate_deepseek_v4_pro","completionsReasoning":{"fireworks":{"history":"interleaved"},"baseten":{"mode":"forced-on"}},"reasoningReplay":"placeholder","noImageSupport":true,"cost":[0.435,0.87,0.003625,0]},
	{"id":"minimax-m3","name":"MiniMax M3","wire":"openai-completions","pool":"core","contextWindow":448000,"maxTokens":64000,"apiProviders":["fireworks"],"credits":{"input":0.12,"output":4},"supportedReasoningEfforts":["high"],"defaultReasoningEffort":"high","featureFlag":"minimax_m3","reasoningReplay":"capture-only","cost":[0.3,1.2,0.06,0]},
	{"id":"grok-4.7","name":"Grok 4.7","wire":"openai-responses","contextWindow":436644,"maxTokens":63356,"apiProviders":["xai"],"credits":{"input":0.8,"output":3,"cacheRead":0.25},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"high","cost":[2,6,0.5,0]},
	{"id":"grok-4.6","name":"Grok 4.6","wire":"openai-responses","contextWindow":200000,"maxTokens":63356,"apiProviders":["xai"],"credits":{"input":0.8,"output":3,"cacheRead":0.25},"supportedReasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"high","cost":[2,6,0.5,0]},
	{"id":"grok-4.5","name":"Grok 4.5","wire":"openai-responses","contextWindow":200000,"maxTokens":63356,"apiProviders":["xai"],"credits":{"input":0.8,"output":3,"cacheRead":0.15},"supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"high","cost":[2,6,0.3,0]},
	{"id":"atlas-07-21","name":"Atlas 07/21 (Preview)","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","featureFlag":"atlas_0721","thinkingStyle":"adaptive-summarized"},
	{"id":"aster-07-15","name":"Aster 07/15 (Preview)","wire":"anthropic-messages","contextWindow":867000,"maxTokens":128000,"apiProviders":["anthropic"],"credits":{"input":2},"supportedReasoningEfforts":["off","low","medium","high","xhigh","max"],"defaultReasoningEffort":"high","featureFlag":"aster_0715","thinkingStyle":"adaptive-summarized"},
	{"id":"minimax-m2.7","name":"MiniMax M2.7","wire":"anthropic-messages","pool":"core","contextWindow":196600,"maxTokens":64000,"apiProviders":["fireworks"],"credits":{"input":0.12,"output":4},"supportedReasoningEfforts":["high"],"defaultReasoningEffort":"high","thinkingStyle":"budget-effort","noImageSupport":true,"cost":[0.3,1.2,0.06,0]},
];
const EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as readonly Effort[];
const BUDGETS: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 12288,
	high: 24576,
	xhigh: 24576,
	max: 0,
};
const EU_UPSTREAMS: Record<string, true> = {
	vertex_anthropic: true,
	bedrock_anthropic: true,
	openai: true,
	bedrock_openai: true,
};
const EU_EDGES: Record<string, true> = {
	arn1: true,
	cdg1: true,
	dub1: true,
	fra1: true,
	lhr1: true,
	mad1: true,
	mxp1: true,
	waw1: true,
};
const POLICY_TTL_MS = 60_000;

type PolicySnapshot = {
	expiresAt: number;
	region?: string;
	servingRegion?: string;
	visible: Map<string, { entry: Entry; upstream: string }>;
};
const policyCache = new Map<string, PolicySnapshot>(); // keyed by residency and access token, never by model alone
const pendingPolicy = new Map<string, Promise<PolicySnapshot>>();

function modelConfig(
	entry: Entry,
	servingRegion?: string,
): ProviderModelConfig {
	const available = entry.supportedReasoningEfforts ?? [];
	const efforts = available.filter((value): value is Effort =>
		EFFORTS.includes(value as Effort),
	);
	const mode =
		entry.wire === "google-generate"
			? "google-level"
			: entry.wire === "anthropic-messages"
				? entry.thinkingStyle === "budget-interleaved"
					? "budget"
					: entry.thinkingStyle === "budget-effort" ||
							entry.thinkingStyle === "budget-effort-beta"
						? "anthropic-budget-effort"
						: "anthropic-adaptive"
				: "effort";
	const thinking: ProviderModelConfig["thinking"] = efforts.length
		? {
				mode,
				efforts,
				...(mode === "anthropic-adaptive" &&
				entry.thinkingStyle === "adaptive-summarized"
					? { supportsDisplay: true }
					: {}),
				requiresEffort:
					!available.includes("off") && !available.includes("none"),
				...(entry.defaultReasoningEffort &&
				EFFORTS.includes(entry.defaultReasoningEffort as Effort)
					? { defaultLevel: entry.defaultReasoningEffort as Effort }
					: {}),
				...(mode === "budget" || mode === "anthropic-budget-effort"
					? { effortBudgets: BUDGETS }
					: {}),
			}
		: undefined;
	const [input, output, cacheRead, cacheWrite] = entry.cost ?? [0, 0, 0, 0];
	return {
		id: entry.id,
		name: entry.name,
		reasoning: !!thinking,
		input: entry.noImageSupport ? ["text"] : ["text", "image"],
		cost: { input, output, cacheRead, cacheWrite },
		contextWindow:
			servingRegion === "eu"
				? (entry.euContextWindow ?? entry.contextWindow)
				: entry.contextWindow,
		maxTokens:
			servingRegion === "eu"
				? (entry.euMaxTokens ?? entry.maxTokens)
				: entry.maxTokens,
		...(thinking ? { thinking } : {}),
	};
}

function rotation(entry: Entry, region?: string): string[] {
	const override =
		region === "eu" ? entry.euApiProviders : entry.globalApiProviders;
	if (override !== undefined)
		return entry.apiProviders.filter((upstream) => override.includes(upstream));
	return region === "eu"
		? entry.apiProviders.filter((upstream) => EU_UPSTREAMS[upstream])
		: entry.apiProviders;
}

function edgeRegion(headers: Headers): "eu" | undefined {
	return EU_EDGES[
		headers.get("x-vercel-id")?.split("::", 1)[0]?.trim().toLowerCase() ?? ""
	]
		? "eu"
		: undefined;
}

async function fetchPolicy(
	access: string,
	accountRegion?: string,
): Promise<PolicySnapshot> {
	const headers = {
		Authorization: `Bearer ${access}`,
		"X-Client-Version": VERSION,
		"X-Factory-Client": "cli",
	};
	const host = apiHost(accountRegion);
	const signal = AbortSignal.timeout(12_000);
	const [flagsResponse, settingsResponse] = await Promise.all([
		fetch(`${host}/api/feature-flags`, { headers, signal }),
		fetch(`${host}/api/organization/managed-settings`, { headers, signal }),
	]);
	if (!flagsResponse.ok || !settingsResponse.ok)
		throw new Error("Factory model policy unavailable");
	const [flagsBody, settingsBody] = await Promise.all([
		flagsResponse.json(),
		settingsResponse.json(),
	]);
	if (
		!isJsonObject(flagsBody) ||
		!isJsonObject(flagsBody.flags) ||
		!isJsonObject(settingsBody) ||
		!isJsonObject(settingsBody.settings)
	)
		throw new Error("Factory model policy invalid");
	const rawPolicy = settingsBody.settings.modelPolicy;
	if (rawPolicy != null && !isJsonObject(rawPolicy))
		throw new Error("Factory model policy invalid");
	const policy = (rawPolicy ?? {}) as Record<string, unknown>;
	for (const field of [
		"allowedModelIds",
		"blockedModelIds",
		"requireExplicitOptInModelIds",
	]) {
		const value = policy[field];
		if (
			value !== undefined &&
			(!Array.isArray(value) || !value.every((id) => typeof id === "string"))
		)
			throw new Error("Factory model policy invalid");
	}
	for (const field of ["allowAllFactoryModels", "isFastModelsAllowed"]) {
		if (policy[field] !== undefined && typeof policy[field] !== "boolean")
			throw new Error("Factory model policy invalid");
	}
	const allowed = policy.allowedModelIds as string[] | undefined;
	const blocked = policy.blockedModelIds as string[] | undefined;
	const requiresOptIn = policy.requireExplicitOptInModelIds as
		| string[]
		| undefined;
	const servingRegion =
		accountRegion === "eu"
			? "eu"
			: (edgeRegion(flagsResponse.headers) ??
				edgeRegion(settingsResponse.headers));
	const rawRouting =
		isJsonObject(flagsBody.configs) &&
		isJsonObject(flagsBody.configs.provider_routing)
			? flagsBody.configs.provider_routing.models
			: undefined;
	const routing = isJsonObject(rawRouting) ? rawRouting : {};
	const visible = new Map<string, { entry: Entry; upstream: string }>();
	for (const entry of ENTRIES) {
		const base = rotation(entry, servingRegion);
		if (
			!base.length ||
			(entry.featureFlag && flagsBody.flags[entry.featureFlag] !== true) ||
			(entry.deprecationFlag &&
				flagsBody.flags[entry.deprecationFlag] === true) ||
			(entry.baseVariant && policy.isFastModelsAllowed === false) ||
			blocked?.includes(entry.id) ||
			requiresOptIn?.includes(entry.id) ||
			(rawPolicy == null && entry.requiresExplicitOptIn) ||
			((policy.allowAllFactoryModels === false || (allowed?.length ?? 0) > 0) &&
				!allowed?.includes(entry.id))
		)
			continue;
		const routed = routing[entry.id];
		const proposed =
			Array.isArray(routed) &&
			routed.every((value) => typeof value === "string")
				? (routed as string[])
				: undefined;
		const upstream =
			servingRegion === "eu" || entry.globalApiProviders !== undefined
				? (proposed?.find((value) => base.includes(value)) ?? base[0])
				: (proposed?.[0] ?? base[0]);
		if (upstream) visible.set(entry.id, { entry, upstream });
	}
	return {
		expiresAt: Date.now() + POLICY_TTL_MS,
		region: accountRegion,
		servingRegion,
		visible,
	};
}

async function currentPolicy(key: string): Promise<PolicySnapshot> {
	const { access, region } = unpackCredential(key);
	if (!access?.trim()) throw new Error("Factory credentials unavailable");
	const token = access.trim();
	const cacheKey = `${region === "eu" ? "eu" : "global"}:${token}`;
	for (const [oldKey, snapshot] of policyCache)
		if (snapshot.expiresAt <= Date.now()) policyCache.delete(oldKey);
	const cached = policyCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached;
	const inFlight = pendingPolicy.get(cacheKey);
	if (inFlight) return inFlight;
	const request = fetchPolicy(token, region)
		.then((snapshot) => {
			policyCache.set(cacheKey, snapshot);
			return snapshot;
		})
		.finally(() => {
			pendingPolicy.delete(cacheKey);
		});
	pendingPolicy.set(cacheKey, request);
	return request;
}

async function discoverFactory(
	key: string | undefined,
): Promise<ProviderModelConfig[]> {
	if (!key) return [];
	const policy = await currentPolicy(key);
	return [...policy.visible.values()].map(({ entry }) =>
		modelConfig(entry, policy.servingRegion),
	);
}

// Called for every inference, including when omp serves a stale discovery cache. No static route on cold cache/failure.
async function routeFactory(
	key: string | undefined,
	id: string,
): Promise<{ entry: Entry; upstream: string; region?: string }> {
	if (!key) throw new Error("Run /login factory-droid first");
	const { visible, region } = await currentPolicy(key);
	const route = visible.get(id);
	if (route) return { ...route, region };
	throw new Error(
		`Factory model ${id} is unavailable for this account or region`,
	);
}

/**
 * Factory Gemini accepts a restricted Schema shape. Keep this projection
 * separate from shared normalizers, which preserve unsupported keywords in
 * description text instead of dropping them.
 */
type JsonObject = Record<string, unknown>;
function isJsonObject(value: unknown): value is JsonObject {
	return !!record(value);
}

/** Schema keywords the CLI copies through verbatim. */
const FACTORY_DROID_ALLOWED_KEYS: Record<string, true> = {
	type: true,
	title: true,
	description: true,
	required: true,
	format: true,
	minimum: true,
	maximum: true,
	minLength: true,
	maxLength: true,
	pattern: true,
	minItems: true,
	maxItems: true,
	default: true,
	example: true,
};

function stringifySchemaValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** True when the node's `type` (string or array form) includes "null". */
function typeIncludesNull(node: JsonObject): boolean {
	if (node.type === "null") return true;
	return Array.isArray(node.type) && (node.type as unknown[]).includes("null");
}

function mergeFactoryDroidSchemas(
	left: JsonObject,
	right: JsonObject,
): JsonObject {
	const merged: JsonObject = { ...left };
	for (const [key, value] of Object.entries(right)) {
		if (key === "properties") {
			const leftProperties = isJsonObject(merged.properties)
				? (merged.properties as JsonObject)
				: {};
			const rightProperties = isJsonObject(value) ? value : {};
			const properties: JsonObject = { ...leftProperties };
			for (const [name, schema] of Object.entries(rightProperties)) {
				if (isJsonObject(leftProperties[name]) && isJsonObject(schema)) {
					properties[name] = mergeFactoryDroidSchemas(
						leftProperties[name] as JsonObject,
						schema,
					);
				} else {
					properties[name] = schema;
				}
			}
			merged.properties = properties;
		} else if (
			key === "required" &&
			Array.isArray(left.required) &&
			Array.isArray(value)
		) {
			merged.required = [
				...(left.required as unknown[]),
				...(value as unknown[]),
			].filter((entry, index, array) => array.indexOf(entry) === index);
		} else if (
			key === "enum" &&
			Array.isArray(left.enum) &&
			Array.isArray(value)
		) {
			merged.enum = [
				...(left.enum as unknown[]),
				...(value as unknown[]),
			].filter((entry, index, array) => array.indexOf(entry) === index);
		} else if (!(key in merged)) {
			merged[key] = value;
		}
	}
	return merged;
}

function copyFactoryDroidSchema(node: unknown): JsonObject | undefined {
	if (!isJsonObject(node)) return undefined;

	const out: JsonObject = {};
	for (const key of Object.keys(FACTORY_DROID_ALLOWED_KEYS)) {
		if (key in node) out[key] = node[key];
	}
	if ("const" in node) out.enum = [stringifySchemaValue(node.const)];
	if (Array.isArray(node.enum)) out.enum = node.enum.map(stringifySchemaValue);

	if (isJsonObject(node.properties)) {
		const properties: JsonObject = {};
		for (const [name, schema] of Object.entries(node.properties)) {
			const copied = copyFactoryDroidSchema(schema);
			if (copied !== undefined) properties[name] = copied;
		}
		out.properties = properties;
	}
	if (isJsonObject(node.items)) {
		const copied = copyFactoryDroidSchema(node.items);
		if (copied !== undefined) out.items = copied;
	}

	// anyOf/oneOf unions: merge the non-null branches, marking the result
	// nullable when a `type: "null"` branch is present.
	const unionKey = Array.isArray(node.anyOf)
		? "anyOf"
		: Array.isArray(node.oneOf)
			? "oneOf"
			: undefined;
	if (unionKey) {
		const branches = (node[unionKey] as unknown[])
			.map(copyFactoryDroidSchema)
			.filter((branch): branch is JsonObject => branch !== undefined);
		const nonNull = branches.filter((branch) => !typeIncludesNull(branch));
		let collapsed: JsonObject | undefined;
		for (const branch of nonNull) {
			collapsed = collapsed
				? mergeFactoryDroidSchemas(collapsed, branch)
				: { ...branch };
		}
		if (collapsed) {
			collapsed.nullable = nonNull.length < branches.length;
			Object.assign(out, collapsed);
		}
	}

	// allOf: merge every branch into this node's own copy.
	if (Array.isArray(node.allOf)) {
		for (const branch of node.allOf) {
			const copied = copyFactoryDroidSchema(branch);
			if (copied) Object.assign(out, mergeFactoryDroidSchemas(out, copied));
		}
	}

	// The Schema proto takes a single string `type`: collapse draft-2020-12
	// type unions the way the shared normalizer does — a null branch becomes
	// `nullable: true`, the first non-null type wins.
	if (Array.isArray(out.type)) {
		const types = (out.type as unknown[]).filter(
			(t): t is string => typeof t === "string",
		);
		const nonNull = types.filter((t) => t !== "null");
		if (types.includes("null")) out.nullable = true;
		out.type = nonNull[0] ?? types[0];
	}
	// The proxy's Schema proto requires a type; infer one when the source
	// omitted it, the same way the CLI's copier does.
	if (!("type" in out)) {
		if (isJsonObject(out.properties)) out.type = "object";
		else if ("items" in out) out.type = "array";
		else if ("enum" in out) out.type = "string";
	}
	return out;
}

/** Project a dereferenced JSON Schema onto Factory Gemini's allowed fields. */
function normalizeSchemaForFactoryDroid(value: unknown): unknown {
	if (!isJsonObject(value)) return value;
	return copyFactoryDroidSchema(value) ?? {};
}

// Reuse the installed CLI's wire codecs, stream parsers, cancellation and tool replay.
const bundledModels = (
	AI as unknown as { getModels(provider: string): Model[] }
).getModels;
function wireModel(model: Model, entry: Entry, region?: string): Model {
	const api =
		entry.wire === "google-generate" ? "google-generative-ai" : entry.wire;
	const provider =
		api === "anthropic-messages"
			? "anthropic"
			: api === "google-generative-ai"
				? "google"
				: api === "openai-completions"
					? "fireworks"
					: "openai";
	const templates = bundledModels(provider);
	const template =
		templates.find(
			(candidate) => candidate.id === entry.id && candidate.api === api,
		) ?? templates.find((candidate) => candidate.api === api);
	if (!template)
		throw new Error(`Installed omp has no ${api} transport template`);
	const path =
		api === "anthropic-messages"
			? "/api/llm/a"
			: api === "google-generative-ai"
				? "/api/llm/g/v1"
				: "/api/llm/o/v1";
	const compat = {
		...template.compat,
		officialEndpoint: false,
		supportsEagerToolInputStreaming: false,
		signingEndpoint: false,
		firstPartyProvider: false,
		injectClaudeCodeInstruction: false,
		stripImageInput: entry.noImageSupport === true,
		wireModelIdMode: "raw",
		supportsTurnScopedSystem: false,
		supportsMidConversationToolChanges: false,
		supportsPerMessageEffort: false,
		...(api === "openai-responses"
			? { supportsDeveloperRole: false, supportsObfuscationOptOut: false }
			: {}),
		...(api === "openai-completions"
			? {
					maxTokensField: "max_tokens",
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					thinkingFormat: "openai",
					requiresToolResultName: entry.toolMessageIncludesName === true,
					disableReasoningOnForcedToolChoice: false,
					disableReasoningOnToolChoice: false,
					allowsSyntheticReasoningContentForToolCalls: false,
					requiresAssistantContentForToolCalls: false,
					requiresThinkingAsText: false,
					replayReasoningContent: !!entry.reasoningReplay,
					requiresReasoningContentForToolCalls:
						entry.reasoningReplay === "placeholder",
					requiresReasoningContentForAllAssistantTurns: false,
					syntheticReasoningContentFallback: " ",
					streamMarkupHealingPattern: undefined,
					thinkingLoopGuard: undefined,
					clampOutputToModelMax: true,
				}
			: {}),
		...(api === "google-generative-ai"
			? {
					requiresSkipThoughtSignature: true,
					supportsFunctionPartId: false,
					multimodalFunctionResponse: true,
				}
			: {}),
	};
	return {
		...model,
		api,
		baseUrl: apiHost(region) + path,
		compat,
		compatConfig: compat,
		identity: template.identity,
		requiresGlyphTokenization: false,
		isOAuth: false,
		omitMaxOutputTokens:
			entry.id.startsWith("gpt-") || entry.wire === "google-generate",
	} as Model;
}

function factoryHeaders(
	access: string,
	upstream: string,
	sessionId: string,
): Record<string, string> {
	const orgId = tokenClaims(access)?.external_org_id;
	return {
		"User-Agent": `factory-cli/${VERSION}`,
		"X-Client-Version": VERSION,
		"X-Factory-Client": "cli",
		"x-api-provider": upstream,
		"x-provider-routing-source": "configured_order",
		"x-session-id": sessionId,
		"x-assistant-message-id": randomUUID(),
		Authorization: `Bearer ${access}`,
		...(typeof orgId === "string" ? { "X-Factory-Org-Id": orgId } : {}),
		// Factory's public CLI router constant, not the signed-in user's organization.
		...(["openai", "azure_openai"].includes(upstream)
			? { "OpenAI-Platform": "org-bHuLtG1fGmYk5YaOihAAXFBw" }
			: {}),
	};
}

function sessionUuid(sessionId?: string): string {
	if (!sessionId) return randomUUID();
	const bytes = createHash("sha256").update(sessionId).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 15) | 64;
	bytes[8] = (bytes[8] & 63) | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function googleToolName(name: string): string {
	const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return clean.length <= 64
		? clean
		: `${clean.slice(0, 64)}_${createHash("sha256").update(clean).digest("hex").slice(0, 8)}`;
}

// omp 18.3.2 predates typed Mistral reasoning. Translate only this request's
// content blocks; the host still owns SSE decoding, token usage and tool events.
function mistralFetch(fetchImpl: FetchImpl): FetchImpl {
	return async (url, init) => {
		const response = await fetchImpl(url, init);
		if (!response.ok || !response.body) return response;
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		let pending = "";
		const transformFrame = (frame: string): string => {
			const data = frame
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") return `${frame}\n\n`;
			let chunk: Record<string, unknown>;
			try {
				chunk = JSON.parse(data);
			} catch {
				return `${frame}\n\n`;
			}
			if (!Array.isArray(chunk.choices)) return `${frame}\n\n`;
			const frames: string[] = [];
			let transformed = false;
			for (const choice of chunk.choices) {
				if (
					!isJsonObject(choice) ||
					!isJsonObject(choice.delta) ||
					!Array.isArray(choice.delta.content)
				)
					continue;
				transformed = true;
				for (const part of choice.delta.content) {
					if (!isJsonObject(part)) continue;
					const delta: Record<string, unknown> = {};
					if (part.type === "thinking" && Array.isArray(part.thinking)) {
						delta.reasoning_content = part.thinking
							.filter(isJsonObject)
							.filter((p) => p.type === "text" && typeof p.text === "string")
							.map((p) => p.text)
							.join("");
					} else if (part.type === "text" && typeof part.text === "string")
						delta.content = part.text;
					else continue;
					frames.push(
						`data: ${JSON.stringify({ ...chunk, usage: undefined, choices: [{ ...choice, delta, finish_reason: null }] })}\n\n`,
					);
				}
				delete choice.delta.content;
				delete choice.delta.reasoning_content;
				delete choice.delta.reasoning;
				delete choice.delta.reasoning_text;
			}
			return transformed
				? `${frames.join("")}data: ${JSON.stringify(chunk)}\n\n`
				: `${frame}\n\n`;
		};
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					pending += decoder.decode(chunk, { stream: true });
					let boundary = /\r?\n\r?\n/.exec(pending);
					while (boundary) {
						controller.enqueue(
							encoder.encode(transformFrame(pending.slice(0, boundary.index))),
						);
						pending = pending.slice(boundary.index + boundary[0].length);
						boundary = /\r?\n\r?\n/.exec(pending);
					}
				},
				flush(controller) {
					pending += decoder.decode();
					if (pending.trim())
						controller.enqueue(encoder.encode(transformFrame(pending)));
				},
			}),
		);
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		headers.delete("content-encoding");
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

function mistralReplay(payload: unknown, context: Context): unknown {
	if (!isJsonObject(payload) || !Array.isArray(payload.messages))
		return payload;
	const history = context.messages.filter(
		(message): message is AssistantMessage =>
			message.role === "assistant" &&
			message.provider === PROVIDER &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted",
	);
	let historyIndex = 0;
	for (const message of payload.messages) {
		if (
			!isJsonObject(message) ||
			message.role !== "assistant" ||
			typeof message.reasoning_content !== "string" ||
			!message.reasoning_content
		)
			continue;
		const text = message.content;
		const originalIndex = history.findIndex(
			(turn, index) =>
				index >= historyIndex &&
				turn.content
					.filter((block) => block.type === "thinking")
					.map((block) => block.thinking)
					.join("\n") === message.reasoning_content &&
				turn.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("") === (text ?? ""),
		);
		if (originalIndex >= 0) {
			message.content = history[originalIndex].content.flatMap<
				Record<string, unknown>
			>((block) =>
				block.type === "thinking" && block.thinking.trim()
					? [
							{
								type: "thinking",
								thinking: [{ type: "text", text: block.thinking }],
							},
						]
					: block.type === "text" && block.text.trim()
						? [{ type: "text", text: block.text }]
						: [],
			);
			historyIndex = originalIndex + 1;
			delete message.reasoning_content;
			continue;
		}
		message.content = [
			{
				type: "thinking",
				thinking: [{ type: "text", text: message.reasoning_content }],
			},
			...(typeof text === "string" && text
				? [{ type: "text", text }]
				: Array.isArray(text)
					? text
					: []),
		];
		delete message.reasoning_content;
	}
	return payload;
}

function streamFactory(
	model: Model,
	context: Context,
	options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
	const EventStream = (
		AI as unknown as {
			AssistantMessageEventStream: new () => AssistantMessageEventStream;
		}
	).AssistantMessageEventStream;
	const outer = new EventStream();
	void (async () => {
		try {
			options.signal?.throwIfAborted();
			const key = await AI.resolveApiKeyOnce(options.apiKey, options.signal);
			if (!key || key === "N/A")
				throw new Error("Run /login factory-droid first");
			const { access } = unpackCredential(key);
			const { entry, upstream, region } = await routeFactory(key, model.id);
			options.signal?.throwIfAborted();
			const wire = wireModel(model, entry, region);
			const sessionId = sessionUuid(options.sessionId);
			const headers = {
				...model.headers,
				...options.headers,
				...factoryHeaders(access, upstream, sessionId),
			};
			const system = context.systemPrompt ?? [];
			const proxied = {
				...context,
				systemPrompt: system[0] === IDENTITY ? system : [IDENTITY, ...system],
			};
			const effort =
				options.disableReasoning || options.forceReasoningOff
					? undefined
					: options.reasoning;
			const base = {
				...options,
				apiKey: access,
				sessionId,
				headers,
				maxInFlightRequests: {},
			};
			let inner: AssistantMessageEventStream;
			const toolNames = new Map(
				context.tools?.map((tool) => [googleToolName(tool.name), tool.name]),
			);
			if (entry.wire === "anthropic-messages") {
				const adaptive = entry.thinkingStyle?.startsWith("adaptive");
				const budgetEffort = entry.thinkingStyle?.startsWith("budget-effort");
				inner = AI.stream(wire, proxied, {
					...base,
					isOAuth: false,
					headers: { ...headers, "x-api-key": "placeholder" },
					thinkingEnabled: !!effort,
					thinkingDisplay: options.hideThinkingSummary ? "omitted" : undefined,
					...(adaptive
						? { effort }
						: {
								thinkingBudgetTokens: effort ? BUDGETS[effort] : undefined,
								...(budgetEffort
									? {
											effort:
												effort === "max" || effort === "xhigh"
													? "high"
													: effort,
										}
									: {}),
							}),
					interleavedThinking:
						entry.thinkingStyle === "budget-interleaved" && !!effort,
					stripThinkingHistory: !adaptive,
					fastMode: entry.fastMode,
					effortBeta:
						entry.thinkingStyle === "budget-effort-beta" ||
						(!!effort &&
							entry.thinkingStyle !== "budget-interleaved" &&
							/^(bedrock|vertex)_anthropic$/.test(upstream)),
					...(upstream === "anthropic" && entry.refusalFallbackModels?.length
						? {
								fallbacks: entry.refusalFallbackModels.map((model) => ({
									model,
								})),
								betas: ["fallback-credit-2026-06-01"],
							}
						: {}),
				} as AnthropicOptions);
			} else if (entry.wire === "openai-responses") {
				const cfg = entry.responsesConfig;
				inner = AI.stream(wire, proxied, {
					...base,
					temperature: undefined,
					statefulResponses: false,
					reasoning: effort,
					reasoningSummary:
						upstream === "xai" ? null : effort ? "auto" : undefined,
					forceReasoningOff: !effort,
					extraBody: {
						prompt_cache_key: sessionId,
						...(cfg?.extendedCache && upstream === "openai"
							? { prompt_cache_retention: "24h" }
							: {}),
						...(cfg?.parallelToolCalls === false
							? { parallel_tool_calls: false }
							: {}),
						...(cfg?.serviceTier ? { service_tier: cfg.serviceTier } : {}),
						...((options.textVerbosity ?? cfg?.verbosity)
							? { text: { verbosity: options.textVerbosity ?? cfg?.verbosity } }
							: {}),
						...(cfg?.safetyId ? { safety_identifier: sessionId } : {}),
					},
				} as OpenAIResponsesOptions);
			} else if (entry.wire === "openai-completions") {
				const mode = entry.completionsReasoning?.baseten?.mode;
				const extraBody =
					upstream === "baseten"
						? mode === "reasoning-effort" || mode === "forced-on"
							? {
									reasoning_effort:
										effort ?? (mode === "forced-on" ? "low" : "none"),
								}
							: effort
								? { chat_template_args: { enable_thinking: true } }
								: {}
						: !effort
							? { reasoning_effort: "none" }
							: upstream === "mistral" ||
									!entry.completionsReasoning?.fireworks?.history
								? {}
								: {
										reasoning_history:
											entry.completionsReasoning.fireworks.history,
									};
				const compat = { ...wire.compat, extraBody };
				const typedReasoning = upstream === "mistral";
				inner = AI.stream(
					{
						...wire,
						compat,
						compatConfig: compat,
					} as Model<"openai-completions">,
					proxied,
					{
						...base,
						...(typedReasoning
							? {
									fetch: mistralFetch(options.fetch ?? fetch),
									onPayload: async (payload: unknown) => {
										const shaped = mistralReplay(payload, context);
										return (
											(await options.onPayload?.(
												shaped,
												model,
												options.signal,
											)) ?? shaped
										);
									},
								}
							: {}),
						temperature: options.temperature ?? 1,
						reasoning: upstream === "baseten" ? undefined : effort,
						disableReasoning: upstream === "baseten" ? undefined : !effort,
					} as OpenAICompletionsOptions,
				);
			} else {
				const fetchImpl = options.fetch ?? fetch;
				inner = AI.stream(wire, proxied, {
					...base,
					maxTokens: undefined,
					onPayload: undefined,
					thinking: {
						enabled: !!effort,
						...(effort
							? {
									level:
										effort === "minimal" || effort === "low"
											? "LOW"
											: effort === "medium" && entry.geminiMedium
												? "MEDIUM"
												: "HIGH",
								}
							: {}),
					},
					fetch: async (_url, init) => {
						const body = JSON.parse(String(init?.body));
						body.model = entry.id;
						if (context.tools?.length)
							body.tools = [
								{
									functionDeclarations: context.tools.map((tool) => ({
										name: googleToolName(tool.name),
										description: tool.description,
										parameters: normalizeSchemaForFactoryDroid(
											AI.dereferenceJsonSchema(AI.toolWireSchema(tool)),
										),
									})),
								},
							];
						for (const content of body.contents ?? [])
							for (const part of content.parts ?? []) {
								delete part.thought;
								if (part.functionCall)
									part.functionCall.name = googleToolName(
										part.functionCall.name,
									);
								if (part.functionResponse)
									part.functionResponse.name = googleToolName(
										part.functionResponse.name,
									);
							}
						const replacement = await options.onPayload?.(
							body,
							model,
							options.signal,
						);
						const requestHeaders = new Headers(init?.headers);
						requestHeaders.delete("x-goog-api-key");
						return fetchImpl(`${wire.baseUrl}/generate`, {
							...init,
							headers: requestHeaders,
							body: JSON.stringify(replacement ?? body),
						});
					},
				} as GoogleOptions);
			}
			for await (const event of inner) {
				if (entry.wire === "google-generate") {
					const message =
						"partial" in event
							? event.partial
							: event.type === "done"
								? event.message
								: event.type === "error"
									? event.error
									: undefined;
					for (const block of message?.content ?? [])
						if (block.type === "toolCall")
							block.name = toolNames.get(block.name) ?? block.name;
				}
				outer.push(event);
			}
			outer.end(await inner.result());
		} catch (error) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: options.signal?.aborted ? "aborted" : "error",
				timestamp: Date.now(),
				errorMessage: options.signal?.aborted
					? "Request cancelled"
					: error instanceof Error
						? error.message
						: "Factory request failed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			outer.push({
				type: "error",
				reason: message.stopReason as "error" | "aborted",
				error: message,
			});
			outer.end(message);
		}
	})();
	return outer;
}

export default function factoryDroid(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, {
		baseUrl: apiHost(),
		api: API,
		streamSimple: streamFactory,
		fetchDynamicModels: discoverFactory,
		oauth: {
			name: "Factory Droid (plugin)",
			login: loginFactory,
			refreshToken: refreshFactory,
			getApiKey: (credentials) =>
				JSON.stringify({
					access: credentials.access,
					region: credentials.region,
				}),
		},
	});
}
