/**
 * Aligns observed FRED ICE BofA US High Yield OAS (%) to a daily calendar.
 * Daily non-publication dates use the latest published observation, with a
 * strict four-calendar-day maximum age. Dates before source coverage are not
 * synthesized: the caller must trim all series to startIndex.
 */
export function alignObservedCreditSpread(
  calendarDates: string[],
  csvContent: string,
  maxObservationAgeDays = 4
): { startIndex: number; values: number[] } {
  const rows = csvContent.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error("FRED OAS CSV has no observations.");
  const header = rows[0].split(",").map(value => value.trim());
  const dateColumn = header.indexOf("observation_date");
  const valueColumn = header.indexOf("BAMLH0A0HYM2");
  if (dateColumn < 0 || valueColumn < 0) {
    throw new Error("FRED OAS CSV is missing required columns.");
  }

  const observations = new Map<string, number>();
  let previousDate = "";
  for (const row of rows.slice(1)) {
    if (!row.trim()) continue;
    const fields = row.split(",");
    const date = fields[dateColumn]?.trim() ?? "";
    const raw = fields[valueColumn]?.trim() ?? "";
    const value = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z"))) {
      throw new Error(`Invalid FRED OAS date: ${date}`);
    }
    if (date <= previousDate) throw new Error(`FRED OAS dates duplicated or unsorted: ${date}`);
    if (!raw || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid FRED OAS value on ${date}: ${raw}`);
    }
    observations.set(date, value);
    previousDate = date;
  }

  const firstObservationDate = observations.keys().next().value as string | undefined;
  if (!firstObservationDate) throw new Error("FRED OAS CSV has no valid observations.");
  const startIndex = calendarDates.findIndex(date => date >= firstObservationDate);
  if (startIndex < 0) throw new Error("Price calendar does not overlap FRED OAS coverage.");

  const observationDates = [...observations.keys()];
  let cursor = 0;
  let lastDate = "";
  let lastValue = 0;
  const values: number[] = [];
  for (const date of calendarDates.slice(startIndex)) {
    while (cursor < observationDates.length && observationDates[cursor] <= date) {
      lastDate = observationDates[cursor];
      lastValue = observations.get(lastDate)!;
      cursor++;
    }
    if (!lastDate) throw new Error(`No prior FRED OAS observation for ${date}.`);
    const ageDays = Math.floor(
      (Date.parse(date + "T00:00:00Z") - Date.parse(lastDate + "T00:00:00Z")) / 86_400_000
    );
    if (ageDays < 0 || ageDays > maxObservationAgeDays) {
      throw new Error(`FRED OAS observation stale on ${date}: last ${lastDate} (${ageDays} days).`);
    }
    values.push(lastValue);
  }
  return { startIndex, values };
}
