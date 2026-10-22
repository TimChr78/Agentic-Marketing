// Reproduce: npm pack @activepieces/piece-slack@0.21.0 && mkdir x && tar xzf activepieces-piece-slack-0.21.0.tgz -C x
// then `node run-piece.cjs`: runs send_channel_message with a hand-built context and logs where it connects.
const seen = [];
setTimeout(() => { console.log('after 8s network', seen); process.exit(0); }, 8000);
const http = require('http'), https = require('https');

for (const [name, mod] of [['http', http], ['https', https]]) {
  const orig = mod.request;
  mod.request = function (...a) { seen.push(name + ' ' + (a[0]?.href ?? a[0]?.hostname ?? a[0])); return orig.apply(this, a); };
}
const origFetch = globalThis.fetch;
globalThis.fetch = (u, i) => { seen.push('fetch ' + u); return origFetch(u, i); };
const { slack } = require('./x/package/src/index.js');
const a = slack.actions().send_channel_message;
a.run({ auth: { access_token: 'xoxb-fake', data: {} }, propsValue: { channel: 'C123', text: 'hi', sendAsBot: true }, store: { get: async () => null, put: async () => {} }, server: {}, files: {}, run: { id: 'r' } })
  .then((r) => console.log('result', JSON.stringify(r).slice(0, 200)))
  .catch((e) => console.log('error', e.message.slice(0, 300)))
  .finally(() => console.log('network', seen));
