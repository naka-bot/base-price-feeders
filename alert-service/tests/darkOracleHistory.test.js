const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findDarkOracleHistory } = require('../dist/darkOracleHistory');
const NOW = 1800000000000;
function fixture({ cadence = 200, eventAge = 9327, eventBlock, fail = false, lag = 0 } = {}) {
  const calls = [];
  const head = 100000n;
  const updateBlock = eventBlock ?? head - BigInt(Math.ceil(eventAge / cadence));
  return { calls, reader: {
    async getBlock(n = head) { return { number: n, timestamp: BigInt(Math.floor((NOW - lag - Number(head - n) * cadence) / 1000)) }; },
    async getLogs(from, to) {
      calls.push([from, to]);
      assert.ok(to - from < 500n);
      if (fail) throw new Error('RPC unavailable');
      return eventAge !== null && updateBlock >= from && updateBlock <= to ? [{ eventName: 'PricesUpdated', args: { timestamp: BigInt(NOW - eventAge) } }] : [];
    },
  }};
}
test('healthy update outside eight 200ms blocks is found', async () => {
  const f = fixture(); const r = await findDarkOracleHistory(f.reader, 48000, NOW);
  assert.equal(Number(r.logs[0].args.timestamp), NOW - 9327);
  assert.ok(100000n - r.fromBlock > 8n);
});
test('same healthy event is found with two-second blocks', async () => {
  const r = await findDarkOracleHistory(fixture({cadence: 2000}).reader, 48000, NOW);
  assert.equal(r.logs.length, 1);
});
test('fast cadence scans multiple nonoverlapping chunks to cover actual time', async () => {
  const f = fixture({cadence: 20, eventAge: null});
  const r = await findDarkOracleHistory(f.reader, 48000, NOW);
  assert.ok(f.calls.length > 1);
  for (let i = 1; i < f.calls.length; i++) assert.equal(f.calls[i][1], f.calls[i-1][0] - 1n);
  assert.ok(Number((await f.reader.getBlock(r.fromBlock)).timestamp) * 1000 <= NOW - 78000);
});
test('transport failure and stale RPC head are errors, not missing-event results', async () => {
  await assert.rejects(findDarkOracleHistory(fixture({fail: true}).reader, 48000, NOW), /RPC unavailable/);
  await assert.rejects(findDarkOracleHistory(fixture({lag: 40000}).reader, 48000, NOW), /head/);
});
test('incomplete bounded scan fails closed', async () => {
  await assert.rejects(findDarkOracleHistory(fixture({cadence: 1,eventAge: null}).reader, 48000, NOW), /scan limit/);
});

process.env.ALCHEMY_RPC_URL = 'http://127.0.0.1:9';
process.env.DARK_ORACLE_ADDRESS = '0x0000000000000000000000000000000000000001';
const contracts = require('../dist/contracts');
const slack = require('../dist/slack');
const { checkStaleness } = require('../dist/monitor');
for (const [label, eventAge, expectedAlert] of [['false positive',9327,false],['threshold boundary',48000,false],['genuinely stale',49000,true],['no updates',null,true]]) {
  test(`upstream freshness check: ${label}`, async t => {
    t.mock.method(Date, 'now', () => NOW);
    const f = fixture({eventAge});
    const alerts = [];
    t.mock.method(slack, 'sendSlackAlert', async message => { alerts.push(message); });
    t.mock.method(contracts.publicClient, 'getBlock', ({blockNumber}) => f.reader.getBlock(blockNumber));
    t.mock.method(contracts.publicClient, 'getLogs', ({fromBlock,toBlock}) => f.reader.getLogs(fromBlock,toBlock));
    t.mock.method(contracts.publicClient, 'readContract', async () => 60000n);
    await checkStaleness();
    assert.equal(alerts.length > 0, expectedAlert);
    if (expectedAlert) assert.match(alerts[0], /Staleness Alert/);
  });
}
