// Tools on Datacircle's open API, for a FastMCP server (fastmcp on npm): find the best GTM APIs. The API needs no key:
// https://api.datacircle.dev/v1 (its spec: https://api.datacircle.dev/v1/openapi.json). More at https://datacircle.dev

import { z } from 'zod/v4';
import { ApiError, BASE_URL, Client, VERSION, brief, briefPlans, clamp, objects, slugify } from './client.js';
import type { Answer, DatacircleOptions } from './client.js';

export { ApiError, BASE_URL, VERSION };
export type { Answer, DatacircleOptions };

const LIST_APIS_ABOUT = "Lists the GTM APIs on Datacircle's sheet (https://datacircle.dev). GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use. Gives each API's slug, how many plans and providers it has and its best plan. Call it first to find an API's slug.";
const BEST_PLANS_ABOUT = "Gives the best providers for an API: its plans best first by their score out of 100 on Datacircle's benchmark (https://datacircle.dev), each with its rank, provider, plan, $ per 1,000 calls and its page. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const SEARCH_PLANS_ABOUT = "Searches every plan on Datacircle's sheet (https://datacircle.dev), or one API's, by provider or plan name, sorted by score, provider or price. Gives how many were found and up to limit of them. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const PROVIDER_ABOUT = "Gives where one provider ranks: each API it sells and its rank on each on Datacircle's benchmark (https://datacircle.dev), with its best plan there, its best rank first. total is how many APIs it sells, ranked on how many of them it has a rank. For an API's best providers, call datacircle_best_plans.";

// Tells a model that sent a provider's name to an API's tool where a provider's plans are.
const FOR_PROVIDER = "A provider's plans: datacircle_search_plans with its name as query, like bright data, or datacircle_provider.";

// Tells a model that sent an API's slug to the provider's tool where an API's best providers are.
const FOR_API = "An API's best providers: datacircle_best_plans with the API's slug, like email-finder.";

// Each key's schema is what the model is sent, and its check runs first on what the model sent. The check is looser than the
// schema, so that a model that strays (another provider's, on an Anthropic-compatible API) is understood where it can be: null
// is a key left out, a number sent as a string is read as one, a fraction cut to its whole part, a number below its least
// takes its default and one above its most is cut to it. A key of its own is dropped. What it refuses, the model reads why.
// Each loose key is optional outside its check too, so that FastMCP 3's JSON Schema of a key's output lists it as optional.
const absent = (value: unknown) => (value === null ? undefined : value);
const count = (low: number, high: number | null, description: string) =>
  z.preprocess((value) => {
    value = absent(value);
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    const n = Math.trunc(value);
    return n < low ? undefined : high !== null && n > high ? high : n;
  }, (high === null ? z.number().int().min(low) : z.number().int().min(low).max(high)).optional()).optional().describe(description);
const text = (description: string) => z.preprocess(absent, z.string().optional()).optional().describe(description);
const needed = (description: string) => z.string().describe(description);
const choice = (values: [string, ...string[]], description: string) => z.preprocess(absent, z.enum(values).optional()).optional().describe(description);

const listApisInput = {
  query: text("Words of the API's name or slug, like email or linkedin profile: the APIs that hold the most of them come first. Left out, the sheet's order"),
  limit: count(1, 200, 'How many APIs to give, 1 to 200. 20 when left out: the sheet has about 150'),
};

const bestPlansInput = {
  slug: needed("The API's slug, like email-finder or linkedin-profile, as datacircle_list_apis gives it"),
  limit: count(1, 50, 'How many plans to give, 1 to 50. 10 when left out'),
};

const searchPlansInput = {
  api: text("Only this API's plans: its name or slug, like email-finder. A provider's name goes in query, never here. Left out, every API"),
  query: text("Words that must all appear in the provider's or plan's name, like bright data. Left out, every plan"),
  sort: choice(['score', 'provider', 'price'], 'score (best first, the default), provider (A to Z) or price ($ per 1,000, lowest first)'),
  limit: count(1, 50, 'How many plans to give, 1 to 50. 10 when left out'),
  offset: count(0, null, 'How many found plans to skip first. 0 when left out'),
};

const providerInput = {
  slug: needed("The provider's slug, like bright-data, or its name, like Bright Data: the name is made a slug"),
};

/** datacircle_list_apis' input. */
export type ListApisInput = { query?: string | null; limit?: number | null };
/** datacircle_best_plans' input. */
export type BestPlansInput = { slug: string; limit?: number | null };
/** datacircle_search_plans' input. */
export type SearchPlansInput = { api?: string | null; query?: string | null; sort?: 'score' | 'provider' | 'price' | null; limit?: number | null; offset?: number | null };
/** datacircle_provider's input. */
export type ProviderInput = { slug: string };

/** A limit the model sent, within the API's bounds, or undefined for the API's default. */
const bounded = (n: number | null | undefined, high: number) => (n === undefined || n === null || !(n >= 1) ? undefined : clamp(n, 1, high));

/** An answer of 4xx (an unknown slug, a wrong argument) is the call's answer as {error}, the API's words. */
function asResult(error: unknown): Answer {
  if (error instanceof ApiError) return { error: error.message };
  throw error;
}

async function listApisRun(client: Client, { query, limit }: ListApisInput, signal?: AbortSignal): Promise<Answer> {
  let apis: Answer[];
  try {
    apis = objects(await client.get<unknown>('/apis', {}, signal));
  } catch (error) {
    return asResult(error);
  }
  const words = (query ?? '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const found = apis
    .map((api, order) => {
      const name = `${String(api.api ?? '')} ${String(api.slug ?? '').replace(/-/g, ' ')}`.toLowerCase();
      return { order, matched: words.filter((word) => name.includes(word)).length, api };
    })
    .filter(({ matched }) => matched > 0 || words.length === 0)
    // The most words matched first, the sheet's order within each.
    .sort((a, b) => b.matched - a.matched || a.order - b.order);
  const answer: Answer = {
    total: found.length,
    apis: found.slice(0, bounded(limit, 200) ?? 20)
      .map(({ api }) => brief(api, ['api', 'slug', 'plans', 'providers', 'best', 'bestPage', 'sheetPage'])),
  };
  if (words.length > 0 && (found.length === 0 || found[0].matched < words.length)) {
    // A provider's name sent as an API's, like Bright Data, whose data matches many APIs: where its plans are.
    answer.note = `No API's name holds every word of ${JSON.stringify(query)}. A provider's plans: datacircle_search_plans with its name as query, or datacircle_provider.`;
  }
  return answer;
}

async function bestPlansRun(client: Client, { slug, limit }: BestPlansInput, signal?: AbortSignal): Promise<Answer> {
  const api = slugify(slug ?? '');
  if (api === '') return { error: `Give an API's slug, like email-finder: datacircle_list_apis gives every slug. ${FOR_PROVIDER}` };
  try {
    const answer = await client.get(`/apis/${api}/best`, { limit: bounded(limit, 50) }, signal);
    return { ...answer, plans: briefPlans(answer.plans) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // A provider's name sent as the API's slug: the API's words, and where a provider's plans are.
      return { error: `${error.message}. datacircle_list_apis gives every API's slug. ${FOR_PROVIDER}` };
    }
    return asResult(error);
  }
}

async function searchPlansRun(client: Client, input: SearchPlansInput, signal?: AbortSignal): Promise<Answer> {
  const search = (api: string, query: string) =>
    client.get('/plans', {
      api: api.trim(),
      query: query.trim(),
      sort: input.sort ?? undefined,
      limit: bounded(input.limit, 50),
      offset: input.offset === undefined || input.offset === null || !(input.offset > 0) ? undefined : Math.trunc(input.offset),
    }, signal);
  let api = input.api ?? '';
  let query = input.query ?? '';
  const notes: string[] = [];
  try {
    let answer: Answer;
    try {
      answer = await search(api, query);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 400 && error.message.includes('api must be') && query.trim() === '')) throw error;
      // A provider's name sent as the API: the plans whose provider or plan name holds it.
      [api, query] = ['', api];
      answer = await search(api, query);
      notes.push(`No API is named ${JSON.stringify(input.api)}: these are the plans whose provider or plan name holds it.`);
    }
    if (answer.total === 0 && query.includes('-')) {
      // A slug sent as a name, like bright-data, which no name holds: its words, like bright data. A name with a
      // hyphen, like A-Leads, is found as it is first.
      const words = query.replace(/-/g, ' ').split(/\s+/).filter(Boolean).join(' ');
      try {
        answer = await search(api, words);
        notes.push(`No provider's or plan's name holds ${JSON.stringify(query)}: these are the plans whose name holds ${JSON.stringify(words)}.`);
      } catch {
        // The first answer stands.
      }
    }
    return { ...answer, plans: briefPlans(answer.plans), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  } catch (error) {
    return asResult(error);
  }
}

async function providerRun(client: Client, { slug }: ProviderInput, signal?: AbortSignal): Promise<Answer> {
  const provider = slugify(slug ?? '');
  if (provider === '') return { error: "Give a provider's slug or name, like bright-data or Bright Data" };
  let answer: Answer;
  try {
    answer = await client.get(`/providers/${provider}`, {}, signal);
  } catch (error) {
    // An API's slug sent as a provider's, like email-finder: the API's words, and where an API's best providers are.
    if (error instanceof ApiError && error.status === 404) return { error: `${error.message}. ${FOR_API}` };
    return asResult(error);
  }
  const apis = objects(answer.apis).map((entry) => {
    const plans = objects(entry.plans);
    const kept: Answer = { ...brief(entry, ['api', 'slug', 'rank', 'bestPage']), plans: plans.length };
    const best = bestPlan(plans);
    if (best) kept.best = brief(best, ['plan', 'score', 'perThousand', 'page']);
    return kept;
  });
  // Its best rank first, the APIs where it has none last, in the API's order.
  const rank = (api: Answer) => (typeof api.rank === 'number' ? api.rank : Infinity);
  apis.sort((a, b) => rank(a) - rank(b));
  return { ...answer, apis, total: apis.length, ranked: apis.filter((api) => typeof api.rank === 'number').length };
}

/** A provider's best plan on an API: its lowest rank, the first when none has a rank. */
function bestPlan(plans: Answer[]): Answer | undefined {
  const ranked = plans.filter((plan) => typeof plan.rank === 'number');
  if (ranked.length === 0) return plans[0];
  return ranked.reduce((best, plan) => ((plan.rank as number) < (best.rank as number) ? plan : best));
}
/** The four tools' names, in their order. */
export type ToolName = 'datacircle_list_apis' | 'datacircle_best_plans' | 'datacircle_search_plans' | 'datacircle_provider';

/** The four tools' names, in their order. */
export const TOOL_NAMES: readonly ToolName[] = ['datacircle_list_apis', 'datacircle_best_plans', 'datacircle_search_plans', 'datacircle_provider'];

/** An error's answer as FastMCP passes it on: its words in one text block, with isError, so that the model can call again. */
export interface DatacircleErrorResult {
  content: { type: 'text'; text: string }[];
  isError: true;
}

/**
 * A tool as server.addTool takes it: its parameters a zod schema (a Standard Schema, which FastMCP checks each call by and
 * lists as JSON Schema). Its execute gives the JSON the model reads as text, or an error result: an answer of 4xx (the API's
 * words) or a failed network. An input its parameters refuse, FastMCP answers with why.
 */
export interface DatacircleTool<Name extends ToolName = ToolName> {
  name: Name;
  description: string;
  parameters: z.ZodObject;
  annotations: { title: string; readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: true };
  execute: (args: Record<string, unknown>, context?: unknown) => Promise<string | DatacircleErrorResult>;
}

/** What addDatacircleTools and datacircleTools take: where the tools call, and which of them to give. */
export interface DatacircleToolsOptions extends DatacircleOptions {
  /** The tools to give, by name. All four when left out. */
  tools?: readonly ToolName[];
}

/** The call's signal, context.signal: it aborts when the client cancels the call, the session ends or timeoutMs passes. */
function signalOf(context: unknown): AbortSignal | undefined {
  return (context as { signal?: AbortSignal } | undefined)?.signal;
}

const failed = (text: string): DatacircleErrorResult => ({ content: [{ type: 'text', text }], isError: true });

function tool<In, Name extends ToolName>(
  client: Client,
  name: Name,
  title: string,
  description: string,
  shape: Record<string, z.ZodType>,
  call: (client: Client, input: In, signal?: AbortSignal) => Promise<Answer>,
): DatacircleTool<Name> {
  return {
    name,
    description,
    parameters: z.object(shape),
    annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    execute: async (args, context) => {
      const signal = signalOf(context);
      let answer: Answer;
      try {
        answer = await call(client, (args ?? {}) as In, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return failed((error as Error).message);
      }
      if (typeof answer.error === 'string') return failed(answer.error);
      return JSON.stringify(answer);
    },
  };
}

/**
 * The four tools, each an object for server.addTool: datacircle_list_apis (GET /apis), datacircle_best_plans
 * (GET /apis/{slug}/best), datacircle_search_plans (GET /plans) and datacircle_provider (GET /providers/{slug}).
 */
export function datacircleTools(options: DatacircleToolsOptions = {}): DatacircleTool[] {
  const client = new Client(options);
  const all: DatacircleTool[] = [
    tool<ListApisInput, 'datacircle_list_apis'>(client, 'datacircle_list_apis', 'List the APIs', LIST_APIS_ABOUT, listApisInput, listApisRun),
    tool<BestPlansInput, 'datacircle_best_plans'>(client, 'datacircle_best_plans', 'Who is best for an API', BEST_PLANS_ABOUT, bestPlansInput, bestPlansRun),
    tool<SearchPlansInput, 'datacircle_search_plans'>(client, 'datacircle_search_plans', 'Search the plans', SEARCH_PLANS_ABOUT, searchPlansInput, searchPlansRun),
    tool<ProviderInput, 'datacircle_provider'>(client, 'datacircle_provider', 'One provider on every API', PROVIDER_ABOUT, providerInput, providerRun),
  ];
  if (options.tools === undefined) return all;
  for (const name of options.tools) {
    if (!TOOL_NAMES.includes(name)) throw new Error(`datacircle: no tool is named ${JSON.stringify(name)}: ${TOOL_NAMES.join(', ')}`);
  }
  return all.filter((t) => options.tools!.includes(t.name));
}

/** A server that takes tools as FastMCP does, one by one by its addTool. */
export interface ToolServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addTool(tool: any): unknown;
}

/** Adds the tools to a FastMCP server, each by its addTool, and gives them. A tool of the same name already there is replaced. */
export function addDatacircleTools(server: ToolServer, options?: DatacircleToolsOptions): DatacircleTool[] {
  const tools = datacircleTools(options);
  for (const t of tools) server.addTool(t);
  return tools;
}

// The same calls without a model: each gives the answer the model would read, as an object, an answer of 4xx as {error}.

/** GET /apis: the APIs, as datacircle_list_apis gives them. */
export const listApis = (input: ListApisInput = {}, options?: DatacircleOptions) => listApisRun(new Client(options), input);

/** GET /apis/{slug}/best: an API's plans best first, as datacircle_best_plans gives them. */
export const bestPlans = (input: BestPlansInput, options?: DatacircleOptions) => bestPlansRun(new Client(options), input);

/** GET /plans: the plans found, as datacircle_search_plans gives them. */
export const searchPlans = (input: SearchPlansInput = {}, options?: DatacircleOptions) => searchPlansRun(new Client(options), input);

/** GET /providers/{slug}: where a provider ranks, as datacircle_provider gives it. */
export const providerRanks = (input: ProviderInput, options?: DatacircleOptions) => providerRun(new Client(options), input);
