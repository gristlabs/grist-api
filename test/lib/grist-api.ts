/**
 * The test is intended to test the behavior of the library, i.e. translating javascript calls to HTTP
 * requests and interpreting the results. But we can only know it's correct by sending these
 * requests to an actual Grist instance and checking their effects.
 *
 * These tests rely on the "replay" library to record and replay requests. When writing the tests, run
 * them with REPLAY=record environment variables to run against an actual Grist instance. If the
 * tests pass, the HTTP requests and responses get recorded in test/fixtures/replay/. When tests run
 * without this environment variables, the requests get matched, and responses get replayed. When
 * replaying, we are not checking Grist functionality, only that correct requests get produced, and
 * that responses get parsed.
 *
 * To record interactions with REPLAY=record, you need to use a functional instance of Grist. Upload
 * document test/fixtures/TestGristDocAPI.grist to Grist, and set SERVER and DOC_ID constants below
 * to point to it. Find your API key, and set GRIST_API_KEY env var to it.
 */
// tslint:disable:object-literal-key-quotes

/// <reference types="../replay" />
import axios from 'axios';
import {assert} from 'chai';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import range = require('lodash/range');
import * as path from 'path';
import * as Replay from 'replay';
import {CellValue, GristDocAPI, IRecord} from '../../lib';

chai.use(chaiAsPromised);

// Set where Replay will record requests, with REPLAY=record env var.
Replay.fixtures = path.join(path.dirname(__dirname), '/fixtures/replay');

// Remove "localhost" from Replay's list of localhosts requests to which it would not record.
Replay.reset('localhost');

// Do not record the Authorization header.
Replay.headers  = (Replay.headers as RegExp[]).filter((r) => !/auth/i.test(r.source));

const DOC_URL = "http://localhost:8080/o/docs-8/doc/28a446f2-903e-4bd4-8001-1dbd3a68e5a5";
const LIVE = Boolean(process.env.REPLAY && process.env.REPLAY !== 'replay');

const initialData = {
  Table1: [
    ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
    [1,     'Apple',      5,      datets(2019, 6, 26),  1,          "RED"],
    [2,     'Orange',     8,      datets(2019, 5, 1),   2,          "ORANGE"],
    [3,     'Melon',      12,     datets(2019, 4, 2),   3,          "GREEN"],
    [4,     'Strawberry', 1.5,    datets(2019, 3, 3),   1,          "RED"],
  ],
};

function assertData(records: IRecord[], expectedWithHeaders: CellValue[][]) {
  const headers = expectedWithHeaders[0] as string[];
  const expected = expectedWithHeaders.slice(1);
  const actual = records.map((r) => headers.map((h) => r[h]));
  assert.deepEqual(actual, expected);
}

function datets(year: number, month1based: number, day: number): number {
  return Date.UTC(year, month1based - 1, day) / 1000;
}

describe("grist-api", function() {
  this.timeout(10000);

  let gristApi: GristDocAPI;
  let interceptor: number;
  let requestNum: number = 0;

  before(function() {
    gristApi = new GristDocAPI(DOC_URL, {apiKey: LIVE ? undefined : "unused"});
  });

  beforeEach(async function() {
    // Include a per-test sequential value into each request, so that the replay module doesn't
    // reuse requests (e.g. fetchTable calls produce different results after changes to doc).
    const testName = this.currentTest!.fullTitle();
    requestNum = 0;
    interceptor = axios.interceptors.request.use((config) => {
      config.headers['X-Request-Num'] = `${testName}/${requestNum++}`;
      return config;
    });
  });

  afterEach(async function() {
    axios.interceptors.request.eject(interceptor);
  });

  it("should parse various doc URLs", async function() {
    function getDocId(docUrlOrId: string) {
      return new GristDocAPI(docUrlOrId, {apiKey: "unused"}).docId;
    }
    assert.equal(getDocId('http://localhost:8080/o/docs/wW5ATuoLAKwH/Receivable/p/1'), 'wW5ATuoLAKwH');
    assert.equal(getDocId('https://public.getgrist.com/doc/foobar/p/19'), 'foobar');
    assert.equal(getDocId('https://gristlabs.getgrist.com/8p81LjiWSEDT/ACME-Tacos-Projects'), '8p81LjiWSEDT');
    assert.equal(getDocId('https://gristlabs.getgrist.com/doc/8p81LjiWSEDT1K1oV9NEX9'), '8p81LjiWSEDT1K1oV9NEX9');
  });

  it("should support fetchTable", async function() {
    // Test the basic fetchTable
    let data: IRecord[] = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);

    // Test fetchTable with filters
    data = await gristApi.fetchTable('Table1', {ColorRef: [1]});
    assertData(data, [
      ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
      [1,     'Apple',      5,      datets(2019, 6, 26),  1,          "RED"],
      [4,     'Strawberry', 1.5,    datets(2019, 3, 3),   1,          "RED"],
    ]);
  });

  it("should support addRecords and deleteRecords", async function() {
    const addedRows = await gristApi.addRecords('Table1', [
      {Text_Field: "Eggs", Num: 2, ColorRef: 3, Date: datets(2019, 1, 17)},
      {Text_Field: "Beets", Num: 2}
    ]);
    assert.deepEqual(addedRows, [5, 6]);

    let data = await gristApi.fetchTable('Table1', {Num: [2]});
    assertData(data, [
      ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
      [5,     'Eggs',       2,      datets(2019, 1, 17),  3,          "GREEN"],
      [6,     'Beets',      2,      null,                 0,          null],
    ]);

    await gristApi.deleteRecords('Table1', [5, 6]);

    data = await gristApi.fetchTable('Table1', {Num: [2]});
    assertData(data, [
      ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
    ]);
  });

  it('should support updateRecords', async function() {
    await gristApi.updateRecords('Table1', [
      {"id": 1, "Num": -5, "Text_Field": "snapple", "ColorRef": 2},
      {"id": 4, "Num": -1.5, "Text_Field": null, "ColorRef": 2},
    ]);

    // Note that the formula field gets updated too.
    let data = await gristApi.fetchTable('Table1');
    assertData(data, [
      ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
      [1,     'snapple',    -5,     datets(2019, 6, 26),  2,          "ORANGE"],
      [2,     'Orange',     8,      datets(2019, 5, 1),   2,          "ORANGE"],
      [3,     'Melon',      12,     datets(2019, 4, 2),   3,          "GREEN"],
      [4,     null,         -1.5,   datets(2019, 3, 3),   2,          "ORANGE"],
    ]);

    // Revert the changes.
    await gristApi.updateRecords('Table1', [
      {"id": 1, "Num": 5, "Text_Field": "Apple", "ColorRef": 1},
      {"id": 4, "Num": 1.5, "Text_Field": "Strawberry", "ColorRef": 1},
    ]);
    data = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);
  });

  it('should support varied updateRecords', async function() {
    // Mismatched column sets work too.
    await gristApi.updateRecords('Table1', [
      {"id": 1, "Num": -5, "Text_Field": "snapple"},
      {"id": 4, "Num": -1.5, "ColorRef": 2},
    ]);

    let data = await gristApi.fetchTable('Table1');
    assertData(data, [
      ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
      [1,     'snapple',    -5,     datets(2019, 6, 26),  1,          "RED"],
      [2,     'Orange',     8,      datets(2019, 5, 1),   2,          "ORANGE"],
      [3,     'Melon',      12,     datets(2019, 4, 2),   3,          "GREEN"],
      [4,     'Strawberry', -1.5,   datets(2019, 3, 3),   2,          "ORANGE"],
    ]);

    // Revert the changes.
    await gristApi.updateRecords('Table1', [
      {"id": 1, "Num": 5, "Text_Field": "Apple"},
      {"id": 4, "Num": 1.5, "ColorRef": 1},
    ]);

    data = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);
  });

  it('should support syncTable', async function() {
    await gristApi.syncTable('Table1', [
      {Text_Field: 'Apple', Num: 17, Date: datets(2020, 5, 1)},
      {Text_Field: 'Banana', Num: 33, Date: datets(2020, 5, 2)},
      {Text_Field: 'Melon', Num: 28, Date: null},
    ], ['Text_Field']);

    let data = await gristApi.fetchTable('Table1');
    assertData(data, [
      ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
      [1,     'Apple',      17,     datets(2020, 5, 1),   1,          "RED"],
      [2,     'Orange',     8,      datets(2019, 5, 1),   2,          "ORANGE"],
      [3,     'Melon',      28,     null,                 3,          "GREEN"],
      [4,     'Strawberry', 1.5,    datets(2019, 3, 3),   1,          "RED"],
      [5,     'Banana',     33,     datets(2020, 5, 2),   0,          null],
    ]);

    // Revert data, and delete the newly-added record.
    await gristApi.syncTable('Table1', [
      {Text_Field: 'Apple', Num: 5, Date: datets(2019, 6, 26)},
      {Text_Field: 'Melon', Num: 12, Date: datets(2019, 4, 2)},
    ], ['Text_Field']);
    await gristApi.deleteRecords('Table1', [5]);

    // Check we are back to where we started.
    data = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);
  });

  it('should support syncTable with filters', async function() {
    // syncTable should check that filters are a subset of key columns.
    await assert.isRejected(
      gristApi.syncTable('Table1', [
        {Text_Field: 'Melon', Num: 100, Date: datets(2020, 6, 1)},
        {Text_Field: 'Strawberry', Num: 200, Date: datets(2020, 6, 2)},
      ], ['Text_Field'], {filters: {"ColorRef": [1]}}),
      /key columns.*filter columns/);

    // If columns don't match the filter, the records are ignored.
    await gristApi.syncTable('Table1', [
      {Text_Field: 'Melon', Num: 100, Date: datets(2020, 6, 1)},
      {Text_Field: 'Strawberry', Num: 200, Date: datets(2020, 6, 2)},
      {Text_Field: 'Melon', Num: 100, Date: datets(2020, 6, 1), ColorRef: 3},
      {Text_Field: 'Strawberry', Num: 200, Date: datets(2020, 6, 2), ColorRef: 3},
    ], ['Text_Field', 'ColorRef'], {filters: {"ColorRef": [1]}});

    // Nothing changed because the first call was rejected, and in the second, the pass-in records
    // didn't match the filter.
    let data = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);

    async function sync() {
      // Try again with the matching filter column included.
      await gristApi.syncTable('Table1', [
        {Text_Field: 'Melon', Num: 100, Date: datets(2020, 6, 1), ColorRef: 1},
        {Text_Field: 'Strawberry', Num: 200, Date: datets(2020, 6, 2), ColorRef: 1},
      ], ['Text_Field', 'ColorRef'], {filters: {"ColorRef": [1]}});

      // Note that Melon got added because it didn't exist in the filtered view.
      data = await gristApi.fetchTable('Table1');
      assertData(data, [
        ['id',  'Text_Field', 'Num',  'Date',               'ColorRef', 'ColorRef_Value'],
        [1,     'Apple',      5,      datets(2019, 6, 26),  1,          "RED"],
        [2,     'Orange',     8,      datets(2019, 5, 1),   2,          "ORANGE"],
        [3,     'Melon',      12,     datets(2019, 4, 2),   3,          "GREEN"],
        [4,     'Strawberry', 200,    datets(2020, 6, 2),   1,          "RED"],
        [5,     'Melon',      100,    datets(2020, 6, 1),   1,          "RED"],
      ]);
    }

    // Run this twice, to test the call AND ensure it's itempotent.
    await sync();
    await sync();

    // Revert data, and delete the newly-added record.
    await gristApi.syncTable('Table1', [
      {Text_Field: 'Strawberry', Num: 1.5, Date: datets(2019, 3, 3), ColorRef: 1},
    ], ['Text_Field', 'ColorRef'], {filters: {"ColorRef": [1]}});
    await gristApi.deleteRecords('Table1', [5]);

    // Check we are back to where we started.
    data = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);
  });

  it('should support chunking', async function() {
    // Using chunk_size should produce 5 requests (4 of 12 records, and 1 of 2). We can tell that
    // by examining the recorded fixture in "test/fixtures/replay/test_chunking", and we test by
    // using the requestNum variable, incremented for each request by axios interceptor.
    const myRange = range(50);
    let startRequestNum: number;

    // tslint:disable-next-line:no-shadowed-variable
    const gristApi = new GristDocAPI(DOC_URL, {apiKey: LIVE ? undefined : "unused", chunkSize: 12});

    startRequestNum = requestNum;
    const rowNums = await gristApi.addRecords(
      'Table1', myRange.map((n) => ({Text_Field: "Chunk", Num: n})));
    assert.deepEqual(rowNums, myRange.map((n) => 5 + n));
    assert.equal(requestNum - startRequestNum, 5);

    // Verify data is correct.
    let data = await gristApi.fetchTable('Table1');
    assertData(data, [
      ...initialData.Table1,
      ...myRange.map((n) => [5 + n, 'Chunk', n, null, 0, null])
    ]);

    // Update data using chunking.
    startRequestNum = requestNum;
    await gristApi.updateRecords('Table1',
      myRange.map((n) => ({id: 5 + n, Text_Field: "Peanut Butter", ColorRef: 2})));
    assert.equal(requestNum - startRequestNum, 5);

    data = await gristApi.fetchTable('Table1');
    assertData(data, [
      ...initialData.Table1,
      ...myRange.map((n) => [5 + n, 'Peanut Butter', n, null, 2, 'ORANGE'])
    ]);

    // Delete data using chunking.
    startRequestNum = requestNum;
    await gristApi.deleteRecords('Table1', myRange.map((n) => 5 + n));
    assert.equal(requestNum - startRequestNum, 5);
    data = await gristApi.fetchTable('Table1');
    assertData(data, initialData.Table1);
  });

  it('should produce helpful errors', async function() {
    await assert.isRejected(gristApi.fetchTable('Unicorn'), /Table not found.*Unicorn/);
    await assert.isRejected(gristApi.fetchTable('Table1', {"ColorRef": [1], "ColorBoom": [2]}), /ColorBoom/);
    await assert.isRejected(gristApi.addRecords('Table1', [{"Text_Field": "Beets", "NumX": 2}]),
      /Invalid column.*NumX/);
  });

  it('should show helpful errors when API key is not set', async function() {
    let api = new GristDocAPI(DOC_URL);
    // Key wasn't explicitly given, but apparently was needed, so check that some info about that
    // gets mentioned.
    // Don't use the real HOME, so that the test doesn't depend on whether there is a
    // ~/.grist-api-key file for the user running the test. We are testing its nonexistence.
    const origHome = process.env.HOME;
    process.env.HOME = '/tmp/grist-api-nonexistent';
    try {
      await assert.isRejected(api.fetchTable('Table1'),
        /No view access.*API key not given.*GRIST_API_KEY env.*\.grist-api-key/);
    } finally {
      process.env.HOME = origHome;
    }

    api = new GristDocAPI(DOC_URL, {apiKey: ''});
    // Key was explicitly given as empty, so nothing to add about it.
    await assert.isRejected(api.fetchTable('Table1'),
      /No view access$/);

    const origEnvVar = process.env.GRIST_API_KEY;
    try {
      process.env.GRIST_API_KEY = '';
      // Key was explicitly given as empty via env var, so nothing to add about it.
      api = new GristDocAPI(DOC_URL);
      await assert.isRejected(api.fetchTable('Table1'),
        /No view access$/);
    } finally {
      process.env.GRIST_API_KEY = origEnvVar;
    }

    api = new GristDocAPI(DOC_URL, {apiKey: 'invalid'});
    // Key was explicitly given, so nothing to add about it.
    await assert.isRejected(api.fetchTable('Table1'),
      /invalid API key/);
  });

  it('should allow access to public docs without API key', async function() {
    const publicDocUrl = 'https://templates.getgrist.com/doc/lightweight-crm';
    let api = new GristDocAPI(publicDocUrl);
    assert.isAbove((await api.fetchTable('Contacts')).length, 5);

    // We can also explicitly specify an empty api key.
    api = new GristDocAPI(publicDocUrl, {apiKey: ''});
    assert.isAbove((await api.fetchTable('Contacts')).length, 5);

    // But explicitly specifying an invalid key will fail, as it should.
    api = new GristDocAPI(publicDocUrl, {apiKey: 'invalid'});
    await assert.isRejected(api.fetchTable('Contacts'), /invalid API key/);
  });
});
