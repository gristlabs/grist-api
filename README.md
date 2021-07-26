# grist-api

[![npm version](https://badge.fury.io/js/grist-api.svg)](https://badge.fury.io/js/grist-api)
[![Build Status](https://travis-ci.org/gristlabs/grist-api.svg?branch=master)](https://travis-ci.org/gristlabs/grist-api)

> NodeJS client for interacting with Grist.

The `grist-api` package simplifies using the [Grist](https://www.getgrist.com)
API in Javascript/TypeScript. There is also an analogous [Python
package](https://pypi.org/project/grist-api/).

## Installation

```bash
npm install grist-api
```

## Usage Example

```javascript
const {GristDocAPI} = require('grist-api');

// Put here the URL of your document.
const DOC_URL = "https://<subdomain>.getgrist.com/doc/12345678-2761-4ef2-bc28-310e634754fb";

async function main() {
  const api = new GristDocAPI(DOC_URL);
  // Add some rows to a table
  await api.addRecords('Food', [
    {Name: 'eggs', AmountToBuy: 12},
    {Name: 'beets', AmountToBuy: 1},
  ]);

  // Fetch all rows.
  const data = await api.fetchTable('Food');
  console.log(data);

  // Sync data by a key column.
  await api.syncTable('Food', [{Name: 'eggs', AmountToBuy: 0}], ['Name']);
}

main();
```

To run this, first prepare a Grist doc to play with:
  1. Create a Grist doc
  2. Add a table named `Food` with columns `Name` and `AmountToBuy`
  3. Set `DOC_URL` in the code above to that of your document (the part after doc ID doesn't
     matter).

To use the API, you need to get your API key in Grist from Profile Settings. Run the code above
with `GRIST_API_KEY=<key>` in the shell environment. The key may also be stored to
`~/.grist-api-key` file.

To access public documents, you may provide an empty string for the API key.

## Classes and methods

### new GristDocAPI(docUrlOrId, options)

Create an API instance. You may specify either a doc URL, or just the doc ID (the part
of the URL after "/doc/"). If you specify a URL, then `options.server` is unneeded and ignored.

The options are:
  - `apiKey` (string) The API key, available in Grist from Profile Settings. If omitted, will be taken from
    `GRIST_API_KEY` env var, or `~/.grist-api-key` file.
  - `server` (string) The server URL, i.e. the part of the document URL before "/doc/". Ignored if
    you specify a full URL for the first argument.
  - `dryrun` (boolean) If set, will not make any changes to the doc. You may run with
    `DEBUG=grist-api` to see what calls it would make.
  - `chunkSize` (number, default: 500) Split large requests into smaller one, each limited to
    chunkSize rows. If your requests are very large and hit size limits, try using a smaller value.

### fetchTable(tableName, filters?)

Fetch all data in the table by the given name, returning a list of records with attributes
corresponding to the columns in that table.

If filters is given, it should be an object mapping column names to array values, to fetch only
records that match. For example `{Name: ['eggs']}`.

### addRecords(tableName, records)

Adds new records to the given table. The data is a list of objects, with attributes
corresponding to the columns in the table. Returns a list of added rowIds.

### deleteRecords(tableName, recordIds)

Deletes records from the given table. The data is a list of record IDs.

### updateRecords(tableName, records)

Update existing records in the given table. The data is a list of objects, with attributes
corresponding to the columns in the table. Each object must contain the key "id" with the
rowId of the row to update.

If records aren't all for the same set of columns, then a single-call update is impossible,
so we'll make multiple calls.

### syncTable(tableName, records, keyColIds, {filters?})

Updates Grist table with new data, updating existing rows or adding new ones, matching rows on
the given key columns. (This method does not remove rows from Grist.)

The `records` parameter is a list of objects with column IDs as attributes.

The `keyColIds` parameter lists primary-key columns, which must be present in the given records.

If `options.filters` is given, it should be an object mapping colIds to arrays
of values. Only records matching these filters will be matched as candidates
for existing rows to update. New records whose columns don't match filters will
be ignored.
