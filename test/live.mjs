// Each tool on the live API through a FastMCP server, as an MCP client calls it: tools/list, then tools/call with the model's
// input, FastMCP's check of it by the tool's schema first; and the answers a model's mistakes get. Run from a project that has
// fastmcp and @datacircle/fastmcp installed:
//   node live.mjs stdio    FastMCP servers started over stdio from this file (node live.mjs serve stdio), as a client starts one
//   node live.mjs http     the same over Streamable HTTP (httpStream) on 127.0.0.1
//   node live.mjs memory   the server in this process, by server.connect (fastmcp 4.27 and later)
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDatacircleTools, bestPlans, datacircleTools, listApis, providerRanks, searchPlans } from '@datacircle/fastmcp';

const [mode = 'stdio', transport] = process.argv.slice(2);
// A fetch that answers nothing until the call is stopped, and says so in the trace.
function hang(note) {
  return (url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => {
      note(`aborted ${init.signal.reason?.message ?? init.signal.reason}`);
      reject(init.signal.reason);
    });
  });
}

// The FastMCP server an app makes: the tools by addDatacircleTools, beside a tool of its own; the variant's options.
async function makeServer(variant, trace) {
  const { FastMCP } = await import('fastmcp');
  const { z } = await import('zod');
  const note = (line) => trace && appendFileSync(trace, line + '\n');
  const options = {
    some: { tools: ['datacircle_best_plans', 'datacircle_search_plans'] },
    traced: { fetch: (url, init) => (note(`${url} ${init.headers['User-Agent']}`), fetch(url, init)) },
    slow: { fetch: hang(note) },
    timeout: { fetch: hang(note) },
    down: { baseURL: 'http://127.0.0.1:9' },
  }[variant] ?? {};
  const server = new FastMCP({ name: 'gtm-helper', version: '1.2.3' });
  if (variant === 'timeout') {
    // One by one by the app's own addTool, each with a timeout of the app's.
    for (const tool of datacircleTools(options)) server.addTool({ ...tool, timeoutMs: 300 });
  } else {
    const added = addDatacircleTools(server, options);
    note(`added ${added.map((t) => t.name).join(',')}`);
  }
  if (variant === 'all') {
    server.addTool({
      name: 'add',
      description: 'Adds two numbers',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => String(a + b),
    });
  }
  return server;
}

async function serve(transport) {
  const server = await makeServer(process.env.DATACIRCLE_TEST_VARIANT ?? 'all', process.env.DATACIRCLE_TEST_TRACE);
  if (transport === 'stdio') await server.start({ transportType: 'stdio' });
  else await server.start({ transportType: 'httpStream', httpStream: { port: Number(process.env.PORT), host: '127.0.0.1' } });
}

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function run() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const self = fileURLToPath(import.meta.url);
  // FastMCP gives a tool the call's signal from 4.16.0: before it, a call stopped still ends for the client, its fetch runs on.
  const fastmcp = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/fastmcp/package.json'), 'utf8')).version;
  const [major, minor] = fastmcp.split('.').map(Number);
  const signals = major > 4 || (major === 4 && minor >= 16);
  // Before 3.26.0, FastMCP reads a schema with the zod 3 it brings, which can see only each key's type in a zod 4 schema.
  const described = major > 3 || (major === 3 && minor >= 26);
  const typed = (name, ok, schema, type) =>
    described ? check(name, ok, JSON.stringify(schema)) : check(`${name} (fastmcp ${fastmcp}: its type at least)`, schema?.type === type || ok, JSON.stringify(schema));
  const dir = mkdtempSync(join(tmpdir(), 'fastmcp-live-'));
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    if (!ok) failed++;
  };

  // A server of the variant and a client on it, over the mode's transport. close() stops both.
  let traces = 0;
  async function connect(variant = 'all') {
    const trace = join(dir, `trace-${++traces}`);
    appendFileSync(trace, '');
    const client = new Client({ name: 'live-test', version: '0.1.0' });
    const env = { ...process.env, DATACIRCLE_TEST_VARIANT: variant, DATACIRCLE_TEST_TRACE: trace };
    let child = null;
    if (mode === 'stdio') {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [self, 'serve', 'stdio'], env, stderr: 'inherit' }));
    } else if (mode === 'http') {
      const port = await freePort();
      child = spawn(process.execPath, [self, 'serve', 'http'], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'] });
      // A run that fails leaves no server behind.
      const server = child;
      process.once('exit', () => server.kill());
      const url = new URL(`http://127.0.0.1:${port}/mcp`);
      for (let tries = 0; ; tries++) {
        try {
          await client.connect(new StreamableHTTPClientTransport(url));
          break;
        } catch (error) {
          if (tries > 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } else {
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
      const server = await makeServer(variant, trace);
      const [ours, theirs] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(ours), client.connect(theirs)]);
    }
    return {
      client,
      traced: () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
      close: async () => {
        await client.close();
        if (child) {
          child.kill();
          await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
        }
      },
    };
  }
  // A call as the model makes it: an answer is JSON text, an error result its words with isError.
  const call = async (client, name, args, options) => {
    let result;
    try {
      result = await client.callTool({ name, arguments: args }, undefined, options);
    } catch (error) {
      if (options?.signal) throw error;
      // An older FastMCP answers an input its check refuses with a protocol error, the same words.
      return { is_error: true, protocol: true, content: error.message };
    }
    const text = result.content?.[0]?.text ?? '';
    if (result.isError) return { is_error: true, content: text };
    return JSON.parse(text);
  };

  const NAMES = 'datacircle_list_apis,datacircle_best_plans,datacircle_search_plans,datacircle_provider,add';
  const main = await connect('all');
  const { client } = main;
  const info = client.getServerVersion();
  check('server info', info?.name === 'gtm-helper' && info.version === '1.2.3', JSON.stringify(info));
  if (mode !== 'memory') check('added', main.traced()[0] === `added ${NAMES.replace(/,add$/, '')}`, main.traced()[0]);
  const listed = (await client.listTools()).tools;
  check('names', listed.map((t) => t.name).join(',') === NAMES, listed.map((t) => t.name).join(','));
  // What the model is sent: an object schema, the needed keys required, numbers as integers in their bounds; read-only hints.
  const schema = Object.fromEntries(listed.map((t) => [t.name, t.inputSchema]));
  const ours = listed.filter((t) => t.name !== 'add');
  check('object schemas', ours.every((t) => t.inputSchema.type === 'object'), ours.map((t) => t.inputSchema.type).join(','));
  check('required', JSON.stringify(ours.map((t) => t.inputSchema.required ?? [])) === '[[],["slug"],[],["slug"]]',
    JSON.stringify(ours.map((t) => t.inputSchema.required ?? [])));
  const limit = schema.datacircle_best_plans.properties.limit;
  typed('limit schema', limit.type === 'integer' && limit.minimum === 1 && limit.maximum === 50 && /1 to 50/.test(limit.description), limit, 'number');
  const slug = schema.datacircle_best_plans.properties.slug;
  typed('slug schema', slug.type === 'string' && /email-finder/.test(slug.description), slug, 'string');
  check('sort schema', JSON.stringify(schema.datacircle_search_plans.properties.sort.enum) === '["score","provider","price"]', JSON.stringify(schema.datacircle_search_plans.properties.sort));
  const offset = schema.datacircle_search_plans.properties.offset;
  typed('offset schema', offset.type === 'integer' && offset.minimum === 0, offset, 'number');
  check('annotations', ours.every((t) => t.annotations?.readOnlyHint === true && t.annotations.openWorldHint === true && t.annotations.title),
    ours.map((t) => t.annotations?.title).join(' / '));
  check('descriptions', ours.every((t) => t.description.includes('https://datacircle.dev')), 'each names https://datacircle.dev');

  let r = await call(client, 'add', { a: 2, b: 3 });
  check("the app's own tool", r === 5, JSON.stringify(r));
  r = await call(client, 'datacircle_list_apis', {});
  check('list_apis', r.total > 100 && r.apis.length === 20 && r.apis[0].slug, `total ${r.total}, first ${r.apis[0]?.slug}`);
  r = await call(client, 'datacircle_list_apis', { query: 'email', limit: '3' });
  check('list_apis email, limit as a string', r.apis?.length === 3 && r.apis.every((a) => /email/i.test(a.api + a.slug)) && !r.note, r.apis?.map((a) => a.slug).join(', '));
  r = await call(client, 'datacircle_list_apis', { query: 'Bright Data' });
  check('list_apis provider name', typeof r.note === 'string' && r.note.includes('datacircle_search_plans'), r.note);
  r = await call(client, 'datacircle_list_apis', { query: null, limit: null });
  check('list_apis nulls', r.apis?.length === 20 && !r.note, `${r.apis?.length} APIs`);
  r = await call(client, 'datacircle_list_apis', { limit: 500 });
  check('list_apis limit 500: cut to 200', r.apis?.length === Math.min(200, r.total), `${r.apis?.length} of ${r.total}`);

  r = await call(client, 'datacircle_best_plans', { slug: 'email-finder', limit: 3 });
  check('best_plans', r.plans?.length === 3 && r.plans[0].rank === 1 && typeof r.plans[0].score === 'number' && r.plans[0].page && !('aggregators' in r.plans[0]),
    `${r.api}: ${r.plans?.map((p) => `${p.rank}. ${p.provider} ${p.score}`).join(' / ')}`);
  r = await call(client, 'datacircle_best_plans', { slug: 'Email Finder', limit: 99 });
  check('best_plans name, limit 99', r.plans?.length >= 10 && r.slug === 'email-finder', `${r.plans?.length} plans`);
  r = await call(client, 'datacircle_best_plans', { slug: 'serp', limit: 2.7 });
  check('best_plans a fraction: cut', r.plans?.length === 2, `${r.plans?.length} plans`);
  r = await call(client, 'datacircle_best_plans', { slug: 'bright-data' });
  check('best_plans unknown slug', r.is_error && r.content.startsWith('no API has the slug bright-data') && r.content.includes('datacircle_search_plans'), r.content);
  r = await call(client, 'datacircle_best_plans', { slug: '' });
  check('best_plans empty slug', r.is_error && r.content.startsWith("Give an API's slug"), r.content);
  r = await call(client, 'datacircle_best_plans', { limit: 2 });
  check('best_plans no slug: the check refuses it', r.is_error && /slug/.test(r.content), r.content?.replace(/\s+/g, ' ').slice(0, 160));
  r = await call(client, 'datacircle_best_plans', { slug: 'serp', limit: 'many' });
  check('best_plans limit not a number: the check refuses it', r.is_error && /limit/.test(r.content), r.content?.replace(/\s+/g, ' ').slice(0, 160));
  r = await call(client, 'datacircle_best_plans', { slug: 'serp', limit: 2, extra: true });
  check('best_plans a key of its own: dropped', r.plans?.length === 2, `${r.plans?.length} plans`);

  r = await call(client, 'datacircle_search_plans', { query: 'bright data', sort: 'price', limit: 5 });
  check('search_plans', r.total > 0 && r.plans.length === 5 && r.plans.every((p) => /bright data/i.test(p.provider)), `total ${r.total}, cheapest ${r.plans?.[0]?.perThousand}`);
  r = await call(client, 'datacircle_search_plans', { api: 'email-finder', limit: 2, offset: 1 });
  check('search_plans api offset', r.plans?.length === 2 && r.plans[0].rank === 2, r.plans?.map((p) => `${p.rank}. ${p.provider}`).join(' / '));
  r = await call(client, 'datacircle_search_plans', { api: 'Bright Data' });
  check('search_plans provider as api', r.total > 0 && r.note?.startsWith('No API is named'), `total ${r.total}: ${r.note}`);
  r = await call(client, 'datacircle_search_plans', { query: 'bright-data' });
  check('search_plans slug as query', r.total > 0 && r.note?.includes('"bright data"'), `total ${r.total}: ${r.note}`);
  r = await call(client, 'datacircle_search_plans', { offset: -3, limit: 0 });
  check('search_plans out of range: the defaults', r.plans?.length === 10, `${r.plans?.length} plans`);
  r = await call(client, 'datacircle_search_plans', { api: null, query: 'emelia', sort: null, limit: null, offset: null });
  check('search_plans nulls', r.total > 0 && r.plans.every((p) => /emelia/i.test(p.provider + p.plan)), `total ${r.total}`);
  r = await call(client, 'datacircle_search_plans', { sort: 'cheapest' });
  check('search_plans bad sort: the check refuses it', r.is_error && /sort/.test(r.content), r.content?.replace(/\s+/g, ' ').slice(0, 160));

  r = await call(client, 'datacircle_provider', { slug: 'Bright Data' });
  check('provider', r.slug === 'bright-data' && r.total > 10 && r.ranked > 0 && r.apis[0].rank <= r.apis[1].rank && r.apis[0].best?.plan,
    `${r.provider}: ${r.total} APIs, ranked on ${r.ranked}, best ${r.apis?.[0]?.api} #${r.apis?.[0]?.rank}`);
  r = await call(client, 'datacircle_provider', { slug: 'nobody-x' });
  check('provider unknown', r.is_error && r.content.startsWith('no provider has the slug nobody-x'), r.content);
  r = await call(client, 'datacircle_provider', { slug: 'email-finder' });
  check("provider: an API's slug", r.is_error && r.content.startsWith('no provider has the slug email-finder') && r.content.includes('datacircle_best_plans'), r.content);
  await main.close();

  // The same calls without a model.
  for (const [name, direct] of [['listApis', () => listApis({ limit: 1 })], ['bestPlans', () => bestPlans({ slug: 'serp', limit: 1 })],
    ['searchPlans', () => searchPlans({ limit: 1 })], ['providerRanks', () => providerRanks({ slug: 'bright-data' })]]) {
    r = await direct();
    check(name, !r.error && (r.apis ?? r.plans)?.length > 0, Object.keys(r).join(','));
  }
  r = await bestPlans({ slug: 'nope-api' });
  check('bestPlans unknown: {error}', r.error?.startsWith('no API has the slug nope-api'), r.error);

  // Some of the tools, by name; a name that is none of them is refused.
  const some = await connect('some');
  const names = (await some.client.listTools()).tools.map((t) => t.name).join(',');
  check('tools option', names === 'datacircle_best_plans,datacircle_search_plans', names);
  await some.close();
  let refused = '';
  try {
    datacircleTools({ tools: ['best_plans'] });
  } catch (error) {
    refused = error.message;
  }
  check('tools option: a wrong name', refused.includes('no tool is named "best_plans"'), refused);

  // Each call's User-Agent, through a fetch of the app's own.
  const traced = await connect('traced');
  await call(traced.client, 'datacircle_best_plans', { slug: 'serp', limit: 1 });
  const seen = traced.traced().filter((line) => !line.startsWith('added'));
  check('fetch option', seen.length === 1 && seen[0] === 'https://api.datacircle.dev/v1/apis/serp/best?limit=1 datacircle-fastmcp/0.1.0', seen.join(' | '));
  await traced.close();

  // A call the client cancels aborts the tool's fetch.
  const slow = await connect('slow');
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stopped')), 300);
  r = await call(slow.client, 'datacircle_best_plans', { slug: 'serp' }, { signal: controller.signal }).then((answer) => answer, (error) => error);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopped = slow.traced().filter((line) => line.startsWith('aborted'));
  check(signals ? 'cancel stops the fetch' : `cancel ends the call (fastmcp ${fastmcp} gives no signal)`,
    r instanceof Error && stopped.length === (signals ? 1 : 0), `client: ${r?.message ?? JSON.stringify(r)}; server: ${stopped.join(' ') || 'not aborted'}`);
  await slow.close();

  // The app's timeoutMs on a tool stops its fetch, and the model reads that it timed out.
  const late = await connect('timeout');
  r = await call(late.client, 'datacircle_search_plans', { query: 'bright data' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const timedOut = late.traced().filter((line) => line.startsWith('aborted'));
  check(signals ? 'timeoutMs stops the fetch' : `timeoutMs ends the call (fastmcp ${fastmcp} gives no signal)`,
    r.is_error && /timed out/.test(r.content) && timedOut.length === (signals ? 1 : 0), `${r.content}; server: ${timedOut.join(' ') || 'not aborted'}`);
  await late.close();

  // A network that fails is the model's to read as an error result, and the run goes on.
  const down = await connect('down');
  r = await call(down.client, 'datacircle_best_plans', { slug: 'serp' });
  check('network down', r.is_error && r.content.startsWith('datacircle:'), r.content);
  r = await call(down.client, 'datacircle_provider', { slug: 'bright-data' });
  check('network down, again', r.is_error && r.content.startsWith('datacircle:'), r.content);
  await down.close();

  rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? `ALL OK (${mode})` : `${failed} FAILED (${mode})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (mode === 'serve') {
  await serve(transport);
} else {
  await run();
}
