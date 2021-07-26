/**
 * Client-side library to interact with Grist.
 */
import axios, { Method } from 'axios';
import * as _debug from 'debug';
import chunk = require('lodash/chunk');
import mapValues = require('lodash/mapValues');
import pick = require('lodash/pick');

// Require type only, since the actual require may not be needed or available,
// depending on how and where grist-api is used.
import type * as FsExtra from 'fs-extra';

const debug = _debug('grist-api');
const debugReq = _debug('grist-api:requests');

// Type for values in Grist data cells.
export type CellValue = number|string|boolean|null|[string, any];

// Record representing a row in a Grist table.
export interface IRecord { [colId: string]: CellValue; }

// Type used by Grist for table data in its API calls, mapping column name to list of values.
export interface ITableData { [colId: string]: CellValue[]; }

// Maps colIds to set of values to include when filtering. The arrays of values will often contain
// a single value. (The type only happens to match ITableData, but has different meaning. In
// particular, arrays of values don't have to be parallel in IFilterSpec.)
export interface IFilterSpec { [colId: string]: CellValue[]; }

export async function getAPIKey(): Promise<string> {
  if (typeof process === 'undefined') {
    throw new Error('In browser environment, Grist API key must be provided');
  }

  // Otherwise, assume we are in node environment.
  if (process.env.GRIST_API_KEY !== undefined) {
    return process.env.GRIST_API_KEY;
  }
  const os = require('os');
  const path = require('path');
  const fse: typeof FsExtra = require('fs-extra');
  const keyPath = path.join(os.homedir(), ".grist-api-key");
  if (await fse.pathExists(keyPath)) {
    return (await fse.readFile(keyPath, {encoding: 'utf8'})).trim();
  }
  throw new Error(`Grist API key not given, or found in GRIST_API_KEY env, or in ${keyPath}`);
}

export interface IGristCallConfig {
  // The API key, available in Grist from Profile Settings. If omitted, will be taken from
  // GRIST_API_KEY env var, or ~/.grist-api-key file.
  apiKey?: string;

  // Server URL. Defaults to 'https://api.getgrist.com'.
  server?: string;

  // If set, will not make any changes to the doc.
  dryrun?: boolean;

  // Split large requests into smaller one, each limited to chunkSize rows. Set to Infinity to
  // disable this. The default value is 500. Grist may reject requests that are too large.
  chunkSize?: number;
}

/**
 * Class for interacting with a Grist document.
 */
export class GristDocAPI {
  private _dryrun: boolean;
  private _docId: string;
  private _server: string;
  private _apiKey: string|null;
  private _chunkSize: number;

  /**
   * Create a GristDocAPI object. You may specify either a doc URL, or just the doc ID (the part
   * of the URL after "/doc/"). If you specify a URL, then options.server is unneeded and ignored.
   *
   * See documentation of IGristCallConfig for options.
   */
  constructor(docUrlOrId: string, options: IGristCallConfig = {}) {
    this._dryrun = Boolean(options.dryrun);
    this._server = options.server || 'https://api.getgrist.com';
    this._apiKey = options.apiKey ?? null;
    this._chunkSize = options.chunkSize || 500;
    const match = /^(https?:\/\/[^\/]+(?:\/o\/[^\/]+)?)\/(?:doc\/([^\/?#]+)|([^\/?#]{12,}))/.exec(docUrlOrId);
    if (match) {
      this._server = match[1];
      this._docId = match[2] || match[3];
    } else {
      this._docId = docUrlOrId;
    }
  }

  /**
   * Returns the docId identifying the document in API calls.
   */
  public get docId(): string { return this._docId; }

  /**
   * Fetch all data in the table by the given name, returning a list of records with attributes
   * corresponding to the columns in that table.
   *
   * If filters is given, it should be a dictionary mapping column names to values, to fetch only
   * records that match.
   */
  public async fetchTable(tableName: string, filters?: IFilterSpec): Promise<IRecord[]> {
    const query = filters ? `?filter=${encodeURIComponent(JSON.stringify(filters))}` : '';
    const data: ITableData = await this._docCall(`tables/${tableName}/data${query}`);
    if (!Array.isArray(data.id)) {
      throw new Error(`fetchTable ${tableName} returned bad response: id column is not an array`);
    }
    // Convert column-oriented data to list of records.
    debug("fetchTable %s returned %s rows", tableName, data.id.length);
    return data.id.map((id, index) => mapValues(data, (col) => col[index]));
  }

  /**
   * Adds new records to the given table. The data is a list of dictionaries, with keys
   * corresponding to the columns in the table. Returns a list of added rowIds.
   */
  public async addRecords(tableName: string, records: IRecord[]): Promise<number[]> {
    if (records.length === 0) { return []; }

    const callData: ITableData[] = chunk(records, this._chunkSize).map((recs) => makeTableData(recs));

    const results: number[] = [];
    for (const data of callData) {
      debug("addRecords %s %s", tableName, descColValues(data));
      const resp = await this._docCall(`tables/${tableName}/data`, data, 'POST');
      results.push(...(resp || []));
    }
    return results;
  }

  /**
   * Deletes records from the given table. The data is a list of record IDs.
   */
  public async deleteRecords(tableName: string, recordIds: number[]): Promise<void> {
    // There is an endpoint missing to delete records, but we can use the "apply" endpoint
    // meanwhile.
    for (const recIds of chunk(recordIds, this._chunkSize)) {
      debug("delete_records %s %s records", tableName, recIds.length);
      const data = [['BulkRemoveRecord', tableName, recIds]];
      await this._docCall('apply', data, 'POST');
    }
  }

  /**
   * Update existing records in the given table. The data is a list of objects, with attributes
   * corresponding to the columns in the table. Each record must contain the key "id" with the
   * rowId of the row to update.
   *
   * If records aren't all for the same set of columns, then a single-call update is impossible,
   * so we'll make multiple calls.
   */
  public async updateRecords(tableName: string, records: IRecord[]): Promise<void> {
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
      callData.push(...chunk(groupRecords, this._chunkSize).map((recs) => makeTableData(recs)));
    }

    for (const data of callData) {
      debug("updateRecods %s %s", tableName, descColValues(data));
      // If a call fails, other calls won't run. TODO we should think of how to do better, perhaps
      // with undo of actions that did succeed (but that has dangers if other code ran in the
      // meantime), or better figuring out a path to transactions.
      await this._docCall(`tables/${tableName}/data`, data, 'PATCH');
    }
  }

  /**
   * Updates Grist table with new data, updating existing rows or adding new ones, matching rows on
   * the given key columns. (This method does not remove rows from Grist.)
   *
   * New data is a list of objects with column IDs as attributes.
   *
   * keyColIds parameter lists primary-key columns, which must be present in the given records.
   *
   * If filters is given, it should be a dictionary mapping colIds to values, where colIds must be
   * included among keyColIds. Only existing records matching these filters will be matched as
   * candidates for rows to update. New records which don't match filters will be ignored too.
   */
  public async syncTable(
    tableName: string, records: IRecord[], keyColIds: string[],
    options: {filters?: IFilterSpec} = {},
  ): Promise<void> {
    const filters = options.filters;
    if (filters && !Object.keys(filters).every((colId) => keyColIds.includes(colId))) {
      throw new Error("syncTable requires key columns to include all filter columns");
    }

    // Maps unique keys to Grist rows
    const gristRows = new Map<string, IRecord>();
    for (const oldRec of await this.fetchTable(tableName, filters)) {
      const key = JSON.stringify(keyColIds.map((colId) => oldRec[colId]));
      gristRows.set(key, oldRec);
    }

    const updateList: IRecord[] = [];
    const addList: IRecord[] = [];
    let dataCount = 0;
    let filteredOut = 0;
    for (const newRec of records) {
      // If we have any filters, ignore new records which don't match them.
      if (filters && !filterMatches(newRec, filters)) {
        filteredOut += 1;
        continue;
      }
      dataCount += 1;
      const key = JSON.stringify(keyColIds.map((colId) => newRec[colId]));
      const oldRec = gristRows.get(key);
      if (oldRec) {
        // TODO: This considers non-primitive values always distinct (e.g. ['d', 1234567]). On the
        // other hand, it's unclear if non-primitive values are ever useful.
        const changedKeys = Object.keys(newRec).filter((colId) => newRec[colId] !== oldRec[colId]);
        if (changedKeys.length > 0) {
          debug("syncTable %s: #%s %s needs updates", tableName, oldRec.id, key,
            changedKeys.map((colId) => [colId, oldRec[colId], newRec[colId]]));
          const update: IRecord = pick(newRec, changedKeys);
          update.id = oldRec.id;
          updateList.push(update);
        }
      } else {
        debug("syncTable %s: %s not in grist", tableName, key);
        addList.push(newRec);
      }
    }

    debug("syncTable %s (%s) with %s records (%s filtered out): %s updates, %s new",
      tableName, gristRows.size, dataCount, filteredOut, updateList.length, addList.length);
    // TODO As for other calls, without transactions, we can be left with only a partial sync if
    // there is an error.
    await this.updateRecords(tableName, updateList);
    await this.addRecords(tableName, addList);
  }

  public async attach(files: File[]): Promise<number[]> {
    const formData = new FormData();
    for (const file of files) {
      formData.append('upload', file);
    }
    return await this._docCall('attach', formData, 'POST');
  }

  /**
   * Low-level interface to make a REST call.
   */
  private async _docCall(docRelUrl: string, data?: object|FormData, method?: Method) {
    return this._call(`/api/docs/${this._docId}/${docRelUrl}`, data, method);
  }

  private async _call(url: string, data?: object|FormData, method?: Method) {
    const fullUrl = `${this._server}${url}`;

    method = method || (data ? 'POST' : 'GET');
    if (this._dryrun && method.toUpperCase() !== 'GET') {
      debug("DRYRUN NOT sending %s request to %s", method, fullUrl);
      return;
    }
    let apiKeyMessage: string|undefined;
    if (this._apiKey === null) {
      // If key is missing, get it on first use (possibly from a file), since the constructor can't be async.
      try {
        this._apiKey = await getAPIKey();
      } catch (err) {
        this._apiKey = '';    // Don't try to fetch it any more
        apiKeyMessage = err.message;
      }
    }
    debug("Sending %s request to %s", method, fullUrl);
    try {
      const authHeader = this._apiKey ? {Authorization: `Bearer ${this._apiKey}`} : {};
      const request = {
        url: fullUrl,
        method,
        data,
        headers: {
          ...authHeader,
          'Content-Type': 'application/json',     // Ignored when using FormData
          'Accept': 'application/json',
        },
      };
      debugReq("Request", request);
      const response = await axios.request(request);
      return response.data;
    } catch (err) {
      // If the error has a string or {"error": ...} content, use that for the error message.
      const errorObj = err.response ? err.response.data : null;
      if (typeof errorObj === 'string') {
        err.message += ' / ' + errorObj;
      } else if (typeof errorObj === 'object' && errorObj && errorObj.error) {
        err.message += " / Grist: " + errorObj.error;
      }
      if (err.response?.status === 403 && apiKeyMessage) {
        err.message += ' / ' + apiKeyMessage;
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

/**
 * Checks if a record matches a set of filters.
 */
function filterMatches(rec: IRecord, filters: IFilterSpec): boolean {
  // TODO: This considers non-primitive values (e.g. ['d', 1234567] as always non-matching.
  return Object.keys(filters).every((colId) => filters[colId].includes(rec[colId]));
}
