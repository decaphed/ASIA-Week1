// ─────────────────────────────────────────────────────────────────────────
// csvParse.js — streaming CSV parse (via csv-parse, an RFC4180-correct
// parser — not a hand-rolled split(',') that would mishandle quoting/
// embedded newlines/commas) with a HARD row-count ceiling enforced
// mid-stream, not after buffering the whole file.
//
// Why mid-stream matters: PDM_UPLOAD_MAX_BYTES (multer's limits.fileSize,
// see middleware/uploadFile.js) bounds the file's ON-DISK size, but does
// nothing to bound its PARSED row count — a small file can still contain
// an enormous number of short rows (this system's own columns are narrow
// numeric/timestamp fields, so a malicious or malformed file could pack
// millions of one-byte rows into a few MB). Buffering the whole parse
// result before checking a row-count limit would already have done the
// expensive work the limit exists to prevent. This wrapper aborts the
// stream itself the moment the ceiling is crossed.
// ─────────────────────────────────────────────────────────────────────────

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';

export const MAX_ROWS = 200_000;

class CsvRowLimitExceededError extends Error {
  constructor(limit) {
    super(`CSV exceeds the maximum of ${limit} rows`);
    this.name = 'CsvRowLimitExceededError';
  }
}

/**
 * @param filePath path to the already-multer-saved temp file.
 * @param maxRows hard ceiling, enforced as rows arrive, not after the fact.
 * @returns { headers: string[], rows: object[] }
 * @throws CsvRowLimitExceededError if the file has more than maxRows data rows.
 */
export function parseCsvFile(filePath, maxRows = MAX_ROWS) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    let settled = false;

    const parser = parse({
      columns: (headerRow) => {
        headers = headerRow;
        return headerRow;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    const fileStream = createReadStream(filePath);

    function fail(err) {
      if (settled) return;
      settled = true;
      fileStream.destroy();
      parser.destroy();
      reject(err);
    }

    parser.on('readable', () => {
      let record;
      // eslint-disable-next-line no-cond-assign
      while ((record = parser.read()) !== null) {
        rows.push(record);
        if (rows.length > maxRows) {
          fail(new CsvRowLimitExceededError(maxRows));
          return;
        }
      }
    });
    parser.on('error', fail);
    fileStream.on('error', fail);
    parser.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ headers: headers ?? [], rows });
    });

    fileStream.pipe(parser);
  });
}

export { CsvRowLimitExceededError };
