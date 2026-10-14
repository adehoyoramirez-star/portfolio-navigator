import fs from "node:fs";
import path from "node:path";

const csvPath = path.join(process.cwd(), "public", "historical_data_daily_augmented.csv");
if (!fs.existsSync(csvPath)) {
  throw new Error(`Historical CSV not found: ${csvPath}`);
}

const raw = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
if (lines.length < 2) throw new Error("Historical CSV has no data rows.");

const headers = lines[0].split(",").map((value) => value.trim());
const dateIndex = headers.indexOf("Date");
if (dateIndex < 0) throw new Error('Historical CSV is missing the "Date" column.');
if (new Set(headers).size !== headers.length) throw new Error("Historical CSV contains duplicate column names.");

type Row = { date: string; day: number; values: string[] };
const rows: Row[] = [];
const structuralErrors: string[] = [];
let blankCells = 0;
let invalidNumericCells = 0;

for (let i = 1; i < lines.length; i++) {
  const fields = lines[i].split(",").map((value) => value.trim());
  if (fields.length !== headers.length) {
    structuralErrors.push(`row ${i + 1}: ${fields.length} fields, expected ${headers.length}`);
    continue;
  }
  const date = fields[dateIndex];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    structuralErrors.push(`row ${i + 1}: invalid ISO date ${JSON.stringify(date)}`);
    continue;
  }
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    structuralErrors.push(`row ${i + 1}: impossible calendar date ${date}`);
    continue;
  }
  for (let c = 0; c < headers.length; c++) {
    if (c === dateIndex) continue;
    const value = fields[c];
    if (!value) {
      blankCells++;
      continue;
    }
    if (!Number.isFinite(Number(value))) invalidNumericCells++;
  }
  rows.push({ date, day: new Date(timestamp).getUTCDay(), values: fields });
}

for (let i = 1; i < rows.length; i++) {
  const previous = rows[i - 1];
  const current = rows[i];
  const deltaDays = (Date.parse(`${current.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`)) / 86_400_000;
  if (current.date <= previous.date) {
    structuralErrors.push(`duplicate/unsorted dates: ${previous.date} -> ${current.date}`);
  } else if (deltaDays !== 1) {
    structuralErrors.push(`calendar gap: ${previous.date} -> ${current.date} (${deltaDays} days)`);
  }
}

const series = headers.filter((header) => header !== "Date");
const stats = series.map((column) => {
  const index = headers.indexOf(column);
  let unchangedTransitions = 0;
  let unchangedWeekendTransitions = 0;
  let unchangedWeekdayTransitions = 0;
  let observedTransitions = 0;
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    const a = previous.values[index];
    const b = current.values[index];
    if (!a || !b || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) continue;
    observedTransitions++;
    if (a === b) {
      unchangedTransitions++;
      // A transition is labelled weekend-related if either endpoint is Saturday/Sunday.
      if (previous.day === 0 || previous.day === 6 || current.day === 0 || current.day === 6) {
        unchangedWeekendTransitions++;
      } else {
        unchangedWeekdayTransitions++;
      }
    }
  }
  return {
    column,
    observedTransitions,
    unchangedTransitions,
    unchangedWeekendTransitions,
    unchangedWeekdayTransitions,
    unchangedPct: observedTransitions ? Number((100 * unchangedTransitions / observedTransitions).toFixed(2)) : null,
  };
});

console.log("HISTORICAL CSV TEMPORAL INTEGRITY AUDIT");
console.log(`File: ${path.relative(process.cwd(), csvPath)}`);
console.log(`Rows: ${rows.length}; columns: ${headers.length}; period: ${rows[0]?.date ?? "n/a"} -> ${rows.at(-1)?.date ?? "n/a"}`);
console.log(`Structural errors: ${structuralErrors.length}; blank cells: ${blankCells}; non-numeric cells: ${invalidNumericCells}`);
console.log("Identical consecutive values (diagnostic only; not proof of forward-fill):");
for (const item of stats) {
  console.log(`- ${item.column}: ${item.unchangedTransitions}/${item.observedTransitions} unchanged (${item.unchangedPct ?? "n/a"}%); weekend-related=${item.unchangedWeekendTransitions}; weekday-only=${item.unchangedWeekdayTransitions}`);
}
if (structuralErrors.length) {
  console.error("STRUCTURAL ERRORS:");
  for (const error of structuralErrors) console.error(`- ${error}`);
  process.exitCode = 1;
}
if (invalidNumericCells > 0) {
  console.error(`Found ${invalidNumericCells} non-numeric nonblank cells.`);
  process.exitCode = 1;
}
