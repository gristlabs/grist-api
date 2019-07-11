# grist-api

[![npm version](https://badge.fury.io/js/grist-api.svg)](https://badge.fury.io/js/grist-api)

> NodeJS client for interacting with Grist.

The `grist-api` package simplifies using the [Grist](https://www.getgrist.com)
API in Javascript/TypeScript. There is also an analogous [Python
package](https://pypi.org/project/grist-api/).

## Installation

```bash
npm install grist-api
```

## Usage

```
const {GristDocAPI} = require('grist-api');

const SERVER = "https://subdomain.getgrist.com"         # Your org goes here
const DOC_ID = "9dc7e414-2761-4ef2-bc28-310e634754fb"   # Document ID goes here

const api = new GristDocAPI(DOC_ID, {server: SERVER});

// Add some rows to a table
api.addRecords('Food', [
  {Name: 'eggs', AmountToBuy: 12},
  {Name: 'beets', AmountToBuy: 1},
]);

// Fetch all rows.
const data = await api.fetchTable('Food');
console.log(data);

// Sync data by a key column.
await api.syncTable('Food', [{Name: 'eggs', AmountToBuy: 0}], ['Name']);
```

To run this, first prepare a Grist doc to play with:
  1. Create a Grist doc
  2. Add a table named `Food` with columns `Name` and `AmountToBuy`
  3. Set `DOC_ID` in the code above to that of your document (the part of the URL after "/doc/").

To use the API, you need to get your API key in Grist from Profile Settings. Run the code above
with `GRIST_API_KEY=<key>` in the shell environment. The key may also be stored to
`~/.grist-api-key` file.

## Classes and methods

### new GristDocAPI(docId, options)

Create an API instance. The doc ID is the part of the document URL after "/doc/". The options are:
  - `apiKey` (string) The API key, available in Grist from Profile Settings. If omitted, will be taken from
    `GRIST_API_KEY` env var, or `~/.grist-api-key` file.
  - `server` (string) The server URL, i.e. the part of the document URL before "/doc/".
  - `dryrun` (boolean) If set, will not make any changes to the doc. You may run with
    `DEBUG=grist-api` to see what calls it would make.
  - `chunkSize` (number, default: 500) Split large requests into smaller one, each limited to
    chunkSize rows. If your requests are very large and hit size limits, try using a smaller value.

### fetchTable(tableName, filters?)

Fetch all data in the table by the given name, returning a list of records with attributes
corresponding to the columns in that table.

If filters is given, it should be a dictionary mapping column names to array values, to fetch only
records that match. For example `{Name: ['eggs']}`.

### addRecords(tableName, records)

Adds new records to the given table. The data is a list of dictionaries, with keys
corresponding to the columns in the table. Returns a list of added rowIds.

### deleteRecords(tableName, recordIds)

Deletes records from the given table. The data is a list of record IDs.

### updateRecords(tableName, records)

Update existing records in the given table. The data is a list of objects, with attributes
corresponding to the columns in the table. Each record must contain the key "id" with the
rowId of the row to update.

If records aren't all for the same set of columns, then a single-call update is impossible,
so we'll make multiple calls.

### syncTable(tableName, records, keyColIds, {filters?})

Updates Grist table with new data, updating existing rows or adding new ones, matching rows on
the given key columns. (This method does not remove rows from Grist.)

New data is a list of objects with column IDs as attributes.

The `keyColIds` parameter lists primary-key columns, which must be present in the given records.

If `options.filters` is given, it should be a dictionary mapping colIds to values. Only records
matching these filters will be matched as candidates for existing rows to update. New records
whose columns don't match filters will be ignored.
