// The package from CommonJS: require gives the same tools, and a call of each kind runs on the live API.
const { FastMCP } = require('fastmcp');
const { addDatacircleTools, bestPlans, datacircleTools, VERSION } = require('@datacircle/fastmcp');

(async () => {
  const server = new FastMCP({ name: 'gtm-helper', version: '1.0.0' });
  const added = addDatacircleTools(server);
  const answer = JSON.parse(await datacircleTools()[1].execute({ slug: 'serp', limit: 2 }));
  const alone = await bestPlans({ slug: 'serp', limit: 1 });
  const ok = added.length === 4 && answer.plans?.length === 2 && alone.plans?.length === 1 && VERSION === '0.1.0';
  console.log(`${ok ? 'ok  ' : 'FAIL'} require: ${added.map((t) => t.name).join(',')}; serp ${answer.plans?.map((p) => p.provider).join(' / ')}`);
  process.exit(ok ? 0 : 1);
})();
