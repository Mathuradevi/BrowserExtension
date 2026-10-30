const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function parser() {
  const context = vm.createContext({});
  vm.runInContext(source('parser.js') + '\nglobalThis.parser = AmazonProductParser;', context);
  return context.parser;
}

function amazonPayload(listing) {
  return {
    asin: 'B000TEST01',
    reconciledListing: { detailPageListingResponse: listing }
  };
}

test('MPN prefers manufacturer part number over part number and model number', () => {
  const result = parser().parse(amazonPayload({
    'manufacturer_part_number#1.value': { value: ' MFG-123 ' },
    'part_number#1.value': { value: 'PART-456' },
    'model_number#1.value': { value: 'MODEL-789' }
  }));
  assert.equal(result.mpn, 'MFG-123');
  assert.equal(result.mpnSource, 'manufacturer_part_number');
});

test('MPN falls back to part number when manufacturer part number is missing', () => {
  const result = parser().parse(amazonPayload({
    'part_number#1.value': { value: 'PART-456' },
    'model_number#1.value': { value: 'MODEL-789' }
  }));
  assert.equal(result.mpn, 'PART-456');
  assert.equal(result.mpnSource, 'part_number');
});

test('MPN falls back to model number when earlier values are empty', () => {
  const result = parser().parse(amazonPayload({
    'manufacturer_part_number#1.value': { value: '   ' },
    'part_number#1.value': { value: '' },
    'model_number#1.value': { value: 'MODEL-789' }
  }));
  assert.equal(result.mpn, 'MODEL-789');
  assert.equal(result.mpnSource, 'model_number');
});

test('MPN supports unqualified Amazon attribute keys and returns empty when absent', () => {
  assert.equal(parser().parse(amazonPayload({ manufacturer_part_number: 'MFG-DIRECT' })).mpn, 'MFG-DIRECT');
  const missing = parser().parse(amazonPayload({}));
  assert.equal(missing.mpn, '');
  assert.equal(missing.mpnSource, '');
});

function runner(records, { shrinking = false, repeated = false } = {}) {
  let state = { processing: true, completed: 0, total: 0 };
  let pending = records.slice();
  const logs = [], processed = [], pages = [];
  const context = vm.createContext({
    importScripts() {}, console: { log() {} },
    chrome: { runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } } },
    ExtensionStorage: {
      getState: async () => ({ ...state }), getLogs: async () => logs,
      setState: async (next) => { state = next; },
      patchState: async (next) => { Object.assign(state, next); }
    },
    SyncLogger: { isEnabled: () => true, log: async (entry) => logs.push(entry) },
    CustomProductApi: { fetchProductsWithoutMpn: async (page) => {
      pages.push(page);
      return { data: repeated ? pending.slice(0, 100) : pending.slice((page - 1) * 100, page * 100), attempt: 1 };
    } },
    record(product) {
      processed.push(product);
      if (shrinking) pending = pending.filter((item) => item !== product);
    }
  });
  vm.runInContext(source('background.js'), context);
  vm.runInContext(`processProduct = async (product) => {
    record(product);
    await ExtensionStorage.patchState({ completed: (await ExtensionStorage.getState()).completed + 1 });
  }; delay = async () => {};`, context);
  return { context, logs, processed, pages, run: () => context.runSync() };
}

const records = (make) => Array.from({ length: 250 }, (_, i) => make(i + 1));
for (const [name, make] of [
  ['normal IDs', (i) => ({ id: i, asin: `ASIN${i}` })],
  ['missing IDs', (i) => ({ asin: `ASIN${i}` })],
  ['alternate fields', (i) => ({ ProductId: i, ASIN: `ASIN${i}` })],
  ['reused IDs', (i) => ({ id: 1, asin: `ASIN${i}` })]
]) {
  test(`processes more than 100 with ${name}`, async () => {
    const run = runner(records(make));
    const result = await run.run();
    assert.equal(run.processed.length, 250);
    assert.equal(result.status, 'completed');
    assert.ok(run.logs.some((log) => log.stage === 'page-filter' && log.pageNo === 2 && log.eligibleCount === 100));
  });
}

test('does not skip products when successful saves shrink pending pages', async () => {
  const run = runner(records((i) => ({ id: i, asin: `ASIN${i}` })), { shrinking: true });
  await run.run();
  assert.equal(run.processed.length, 250);
  assert.deepEqual(run.pages, [1, 1, 1, 1]);
});

test('repeated backend pages fail clearly instead of requesting 1000 pages', async () => {
  const run = runner(records((i) => ({ id: i, asin: `ASIN${i}` })), { repeated: true });
  await assert.rejects(run.run(), /Pagination stalled: pages 1 and 2/);
  assert.equal(run.processed.length, 100);
  assert.deepEqual(run.pages, [1, 1, 2]);
});

test('duplicates inside a batch are attempted once', async () => {
  const run = runner([{ id: 1, asin: 'A' }, { id: '1', asin: 'A' }, { id: 2, asin: 'B' }]);
  await run.run();
  assert.equal(run.processed.length, 2);
});

test('invalid identities stop with response diagnostics', async () => {
  const run = runner([{ title: 'No ID or ASIN' }]);
  await assert.rejects(run.run(), /neither a usable ID nor ASIN/);
  assert.equal(run.logs.find((log) => log.stage === 'page-response-details').missingIdCount, 1);
});

test('ID aliases and ASIN fallback normalize safely', () => {
  const { context } = runner([]);
  assert.equal(context.productIdOf({ id: '', Id: 9 }), 9);
  assert.equal(context.productAsinOf({ asin: '', ASIN: ' ABC ' }), 'ABC');
  assert.notEqual(context.productKey({ asin: 'A' }), context.productKey({ asin: 'B' }));
});

test('completed ASIN remains visible with an explicit activity message', async () => {
  const run = runner([]);
  await run.context.ExtensionStorage.setState({
    processing: true,
    completed: 7,
    successful: 7,
    failed: 0,
    currentAsin: 'PREVIOUS',
    currentProductId: 10
  });
  await run.context.markSuccess({
    asin: 'B000TEST01',
    pageNo: 1,
    productId: 11,
    parsed: {},
    amazonRetryCount: 0,
    customApiRetryCount: 0
  });
  const state = await run.context.ExtensionStorage.getState();
  assert.equal(state.completed, 8);
  assert.equal(state.currentAsin, 'B000TEST01');
  assert.equal(state.activity, 'Processed ASIN B000TEST01 successfully.');
});

test('logging serializes concurrent writes and bounds history when explicitly enabled', async () => {
  const data = { approvalLogs: Array.from({ length: 1999 }, (_, i) => ({ i })) };
  const context = vm.createContext({ console, __PRODUCT_SYNC_LOGGING_ENABLED__: true, chrome: {
    storage: { local: {
      get: async () => structuredClone(data),
      set: async (values) => { Object.assign(data, structuredClone(values)); },
      remove: async () => {}
    } },
  } });
  vm.runInContext(source('storage.js') + '\n' + source('logger.js') + '\nglobalThis.logger = SyncLogger;', context);
  await Promise.all([context.logger.log({ marker: 'first' }), context.logger.log({ marker: 'second' }), context.logger.log({ marker: 'third' })]);
  assert.equal(data.approvalLogs.length, 2000);
  assert.deepEqual(data.approvalLogs.slice(-3).map((log) => log.marker), ['first', 'second', 'third']);
});

test('custom API logs request status and does not log save payloads', async () => {
  const logs = [];
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    SyncLogger: { log: async (entry) => logs.push(entry) },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [] })
  });
  vm.runInContext(source('api.js') + '\nglobalThis.api = CustomProductApi;', context);
  await context.api.fetchProductsWithoutMpn(2, 100, 'IN');
  assert.match(logs[0].url, /PageNo=2&PageSize=100&countryCode=IN/);
  assert.equal(logs[1].httpStatus, 200);
  await context.api.saveProduct({ privateField: 'not-for-logs' });
  assert.ok(!JSON.stringify(logs).includes('not-for-logs'));
});
