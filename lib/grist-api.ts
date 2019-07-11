/**
 * Client-side library to interact with Grist.
 */
import axios, { Method } from 'axios';
import * as _debug from 'debug';
import * as fse from 'fs-extra';
import chunk = require('lodash/chunk');
import mapValues = require('lodash/mapValues');
import * as os from 'os';
import * as path from 'path';

const debug = _debug('grist-api');
const debugReq = _debug('grist-api:requests');

// Type for values in Grist data cells.
export type CellValue = number|string|boolean|null|[string, any];

// Record representing a row in a Grist table.
export interface IRecord { [colId: string]: CellValue; }

// Type used by Grist for table data in its API calls, mapping column name to list of values.
export interface ITableData { [colId: string]: CellValue[]; }

export async function getAPIKey(): Promise<string> {
  if (process.env.GRIST_API_KEY) {
    return process.env.GRIST_API_KEY;
  }
  const keyPath = path.join(os.homedir(), ".grist-api-key");
  if (fse.pathExists(keyPath)) {
    return (await fse.readFile(keyPath, {encoding: 'utf8'})).trim();
  }
  throw new Error(`Grist API key not found in GRIST_API_KEY env, nor in ${keyPath}`);
}

/**
 * Class for interacting with a Grist document.
 */
export class GristDocAPI {
  /**
   * Create a GristDocAPI object with the API Key (available from user settings), DocId (the part
   * of the URL after /doc/), and optionally a server URL. If dryrun is true, will not make any
   * changes to the doc. The API key, if omitted, is taken from GRIST_API_KEY env var, or
   * ~/.grist-api-key file.
   */
  public static async create(docId: string, options: {apiKey?: string, server?: string, dryrun?: boolean} = {}) {
    return new GristDocAPI(docId, {
      dryrun: Boolean(options.dryrun),
      server: options.server || 'https://api.getgrist.com',
      apiKey: options.apiKey || await getAPIKey(),
    });
  }

  private _dryrun: boolean;
  private _server: string;
  private _apiKey: string;

  /**
   * The constructor is private. Use GristDocAPI.create(). (It is separate because involves an
   * possible async call.)
   */
  private constructor(private _docId: string, options: {apiKey: string, server: string, dryrun: boolean}) {
    this._dryrun = options.dryrun;
    this._server = options.server;
    this._apiKey = options.apiKey;
  }

  /**
   * Fetch all data in the table by the given name, returning a list of records with attributes
   * corresponding to the columns in that table.
   *
   * If filters is given, it should be a dictionary mapping column names to values, to fetch only
   * records that match.
   */
  public async fetchTable(tableName: string, filters?: {[colId: string]: CellValue[]}): Promise<IRecord[]> {
    const query = filters ? `?filter=${encodeURIComponent(JSON.stringify(filters))}` : '';
    const data: ITableData = await this._call(`tables/${tableName}/data${query}`);
    // Convert column-oriented data to list of records.
    debug("fetchTable %s returned %s rows", tableName, data.id.length);
    return data.id.map((id, index) => mapValues(data, (col) => col[index]));
  }

  /**
   * Adds new records to the given table. The data is a list of dictionaries, with keys
   * corresponding to the columns in the table. Returns a list of added rowIds.
   *
   * If chunkSize is given, we'll make multiple requests, each limited to chunkSize rows.
   */
  public async addRecords(tableName: string, records: IRecord[], chunkSize: number = Infinity): Promise<number[]> {
    if (records.length === 0) { return []; }

    const callData: ITableData[] = chunk(records, chunkSize).map((recs) => makeTableData(recs));

    const results: number[] = [];
    for (const data of callData) {
      debug("addRecords %s %s", tableName, descColValues(data));
      const resp = await this._call(`tables/${tableName}/data`, data, 'POST');
      results.push(...(resp || []));
    }
    return results;
  }

  /**
   * Deletes records from the given table. The data is a list of record IDs.
   */
  public async deleteRecords(tableName: string, recordIds: number[], chunkSize: number = Infinity): Promise<void> {
    // There is an endpoint missing to delete records, but we can use the "apply" endpoint
    // meanwhile.
    for (const recIds of chunk(recordIds, chunkSize)) {
      debug("delete_records %s %s records", tableName, recIds.length);
      const data = [['BulkRemoveRecord', tableName, recIds]];
      await this._call('apply', data, 'POST');
    }
  }

  /**
   * Update existing records in the given table. The data is a list of objects, with attributes
   * corresponding to the columns in the table. Each record must contain the key "id" with the
   * rowId of the row to update.
   *
   * If records aren't all for the same set of columns, then a single-call update is impossible,
   * so we'll make multiple calls.
   * When groupIfNeeded is set, we'll make multiple calls. Otherwise, will raise an exception.
   *
   * If chunkSize is given, we'll make multiple requests, each limited to chunkSize rows.
   */
  public async updateRecords(tableName: string, records: IRecord[], chunkSize: number = Infinity): Promise<void> {
    const groups = new Map<string, IRecord[]>();
    for (const rec of records) {
      if (!rec.id || typeof rec.id !== 'number') {
        throw new Error("updateRecord requires numeric 'id' attribute in each record");
      }
      const key = JSON.stringify(Object.keys(rec).sort());
      const group = groups.get(key) || groups.set(key, []).get(key)!;
      group.push(rec);
    }

    const callData: ITableData[] = [];
    for (const groupRecords of groups.values()) {
      callData.push(...chunk(groupRecords, chunkSize).map((recs) => makeTableData(recs)));
    }

    for (const data of callData) {
      debug("updateRecods %s %s", tableName, descColValues(data));
      await this._call(`tables/${tableName}/data`, data, 'PATCH');
    }
  }

  /**
   * Low-level interface to make a REST call.
   */
  private async _call(url: string, jsonData?: object, method?: Method, prefix?: string) {
    if (prefix == null) {
      prefix = `/api/docs/${this._docId}/`;
    }
    method = method || (jsonData ? 'POST' : 'GET');

    const fullUrl = this._server + prefix + url;
    if (this._dryrun && method.toUpperCase() !== 'GET') {
      debug("DRYRUN NOT sending %s request to %s", method, fullUrl);
      return;
    }
    debug("Sending %s request to %s", method, fullUrl);
    try {
      const request = {
        url: fullUrl,
        method,
        data: jsonData,
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      };
      debugReq("Request", request);
      const response = await axios.request(request);
      return response.data;
    } catch (err) {
      // If the error has {"error": ...} content, use that for the error message.
      const errorObj = err.response ? err.response.data : null;
      if (typeof errorObj === 'object' && errorObj && errorObj.error) {
        err.message = "Grist: " + errorObj.error;
      }
      throw err;
    }
  }
}

/**
 * Returns a human-readable summary of the given ITableData object (dict mapping column name to
 * list of values).
 */
function descColValues(data: ITableData): string {
  const keys = Object.keys(data);
  const numRows = keys.length > 0 ? data[keys[0]].length : 0;
  const columns = keys.sort().join(', ');
  return `${numRows} rows, cols (${columns})`;
}

/**
 * Converts an array of records into a column-oriented ITableData object.
 */
function makeTableData(records: IRecord[]): ITableData {
  const allKeys: IRecord = {};
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      allKeys[key] = null;
    }
  }
  return mapValues(allKeys, (_, key) => records.map((rec) => rec[key]));
}
