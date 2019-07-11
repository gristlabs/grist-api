/**
 * The test is intended to test the behavior of the library, i.e. translating python calls to HTTP
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

/// <reference types="../replay" />
import axios from 'axios';
import {assert} from 'chai';
import * as path from 'path';
import * as Replay from 'replay';
import {CellValue, GristDocAPI, IRecord} from '../../lib';

// Set where Replay will record requests, with REPLAY=record env var.
Replay.fixtures = path.join(path.dirname(__dirname), '/fixtures/replay');

// Remove "localhost" from Replay's list of localhosts requests to which it would not record.
Replay.reset('localhost');

// Do not record the Authorization header.
Replay.headers  = (Replay.headers as RegExp[]).filter((r) => !/auth/i.test(r.source));

const SERVER = "http://localhost:8080/o/docs-8";
const DOC_ID = "28a446f2-903e-4bd4-8001-1dbd3a68e5a5";
const LIVE = Boolean(process.env.REPLAY === 'record');

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
  let gristApi: GristDocAPI;
  let interceptor: number;

  before(async function() {
    gristApi = await GristDocAPI.create(DOC_ID, {server: SERVER, apiKey: LIVE ? undefined : "unused"});
  });

  beforeEach(async function() {
    // Include a per-test sequential value into each request, so that the replay module doesn't
    // reuse requests (e.g. fetchTable calls produce different results after changes to doc).
    const testName = this.currentTest!.fullTitle();
    let requestNum = 0;
    interceptor = axios.interceptors.request.use((config) => {
      config.headers['X-Request-Num'] = `${testName}/${requestNum++}`;
      return config;
    });
  });

  afterEach(async function() {
    axios.interceptors.request.eject(interceptor);
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
});
