# Datacircle tools for FastMCP

Find the best GTM APIs. We benchmark all the GTM APIs and we put the results on our website.

Our website: https://datacircle.dev

This package gives four tools for a [FastMCP](https://github.com/punkpeye/fastmcp) server. The tools call Datacircle's open API, https://api.datacircle.dev/v1. You need no key and no account.

| Tool | What the tool gives | Call |
| --- | --- | --- |
| `datacircle_list_apis` | Every GTM API on Datacircle, with the API's slug, number of plans, number of providers and best plan | `GET /apis` |
| `datacircle_best_plans` | One API's plans, best score out of 100 first. Each plan comes with a rank and a price per 1,000 calls | `GET /apis/{slug}/best` |
| `datacircle_search_plans` | Plans that match a provider or plan name, on all APIs or on one API. You can sort them by score, provider or price | `GET /plans` |
| `datacircle_provider` | The APIs a provider sells, and the provider's rank on each API | `GET /providers/{slug}` |

## Add the tools to your server

```bash
npm install @datacircle/fastmcp fastmcp
```

```ts
import { FastMCP } from 'fastmcp';
import { addDatacircleTools } from '@datacircle/fastmcp';

const server = new FastMCP({ name: 'my-server', version: '1.0.0' });
addDatacircleTools(server);
// Add your own tools here too.

server.start({ transportType: 'stdio' });
```

The tools work the same over `httpStream`, for example `server.start({ transportType: 'httpStream', httpStream: { port: 8080 } })`. They work on fastmcp 3.0.0 and later, from ESM or CommonJS, on Node.js 20 or later. Before fastmcp 3.26.0, the server may list each argument with its type only, without its description.

To add only some of the tools, name them: `addDatacircleTools(server, { tools: ['datacircle_best_plans', 'datacircle_search_plans'] })`.

`datacircleTools()` gives the four tools as objects for `server.addTool`. Use it to add each tool yourself or to set a FastMCP option on a tool:

```ts
import { datacircleTools } from '@datacircle/fastmcp';

for (const tool of datacircleTools()) {
  server.addTool({ ...tool, timeoutMs: 10_000 });
}
```

## Make each call yourself

You can make each call without a server. Each call returns the answer as an object:

```ts
import { bestPlans } from '@datacircle/fastmcp';

const answer = await bestPlans({ slug: 'email-finder', limit: 3 });
console.log(answer.plans);
```

The other calls are `listApis()`, `searchPlans()` and `providerRanks()`.

## What the model reads

Each tool gives the model a JSON object as text. Each plan comes with a rank, provider, plan, score, price per 1,000 (`perThousand`, in dollars) and a page on datacircle.dev. The page on datacircle.dev lists every field.

An unknown slug gets an error result (`isError`) with the API's message and the tool to call instead. If an input does not fit the tool's schema, FastMCP returns an error that names each wrong argument. If the network fails, the model gets an error result with the network error's message. After an error, the model can call the tool again and keep working. On fastmcp 4.16.0 and later, when the client cancels a call or the tool's `timeoutMs` passes, the tool's request stops too.

`addDatacircleTools(server, { fetch })` sets the `fetch` the tools use, for example to add a proxy. To make a call from your code with your own `fetch`, pass `{ fetch }` as the call's second argument, like `bestPlans({ slug: 'serp' }, { fetch })`.

## Network

Each tool call makes one HTTPS GET request to https://api.datacircle.dev/v1 and nothing else. The request holds only the tool's own arguments: no key and nothing from your chats. The API takes up to 60 calls a minute from one IP address. After a 429 answer (too many calls), the tool waits up to a minute and tries once more. The package depends only on zod 4, beside fastmcp. Your own code can use zod 3 or zod 4. The package stores nothing.

## Links

- Datacircle: https://datacircle.dev
- The API: https://datacircle.dev/api
- The API's spec: https://api.datacircle.dev/v1/openapi.json
- What each key means: https://datacircle.dev/fields

MIT license.
