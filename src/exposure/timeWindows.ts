import { getDayRange } from '../sun/sunPosition';

export interface TimeSamples {
  dates: Date[];
  /** Ratio (0..1) tussen actueel aantal samples en wat 100% zon zou opleveren. */
  totalDaylightSamples: number;
  /** Aantal seconden per sample (om uren te kunnen berekenen). */
  intervalMinutes: number;
  label: string;
}

/**
 * Terras-default: 1 juli van 16:00 tot 22:00, stap 5 min.
 * Avondzon-focus voor zomerse terrastijd.
 */
export function terrasZomerAvond(year: number = new Date().getFullYear()): TimeSamples {
  return windowSamples(year, 6, 1, 16, 0, 22, 0, 5, '1 juli, 16:00–22:00 (avondzon)');
}

/**
 * Algemeen venster, voor uurcurve-berekeningen en custom modi.
 */
export function windowSamples(
  year: number,
  monthZeroBased: number,
  day: number,
  startHour: number,
  startMin: number,
  endHour: number,
  endMin: number,
  stepMin: number,
  label: string,
): TimeSamples {
  const dates: Date[] = [];
  const start = new Date(year, monthZeroBased, day, startHour, startMin, 0);
  const end = new Date(year, monthZeroBased, day, endHour, endMin, 0);
  for (let t = start.getTime(); t <= end.getTime(); t += stepMin * 60000) {
    dates.push(new Date(t));
  }
  return { dates, totalDaylightSamples: dates.length, intervalMinutes: stepMin, label };
}

/**
 * Hele zomerdag op 1 juli, vanaf zonsopkomst tot zonsondergang.
 */
export function terrasZomerDag(year: number = new Date().getFullYear()): TimeSamples {
  const ref = new Date(year, 6, 1, 12, 0, 0);
  const range = getDayRange(ref);
  const dates: Date[] = [];
  const stepMin = 10;
  for (let t = range.sunrise.getTime(); t <= range.sunset.getTime(); t += stepMin * 60000) {
    dates.push(new Date(t));
  }
  return {
    dates,
    totalDaylightSamples: dates.length,
    intervalMinutes: stepMin,
    label: '1 juli, hele dag',
  };
}

/**
 * Op een gegeven dag: alle daglicht-samples om 10 min.
 * Voor klik-interactie (uurcurve op die plek voor die dag).
 */
export function uurCurveSamples(date: Date, stepMin: number = 15): TimeSamples {
  const range = getDayRange(date);
  const dates: Date[] = [];
  for (let t = range.sunrise.getTime(); t <= range.sunset.getTime(); t += stepMin * 60000) {
    dates.push(new Date(t));
  }
  return {
    dates,
    totalDaylightSamples: dates.length,
    intervalMinutes: stepMin,
    label: date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' }),
  };
}

/**
 * Kas-windows: één dag per maand (de 15e), zonsopkomst → -ondergang, stap 30 min.
 * @param months 0-based maand-indices (0=jan, 11=dec). Default = alle 12.
 */
export function kasMaandSamples(
  months: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  year: number = new Date().getFullYear(),
  stepMin: number = 30,
): TimeSamples {
  const dates: Date[] = [];
  for (const m of months) {
    const dayInMonth = new Date(year, m, 15, 12, 0, 0);
    const range = getDayRange(dayInMonth);
    for (let t = range.sunrise.getTime(); t <= range.sunset.getTime(); t += stepMin * 60000) {
      dates.push(new Date(t));
    }
  }
  return {
    dates,
    totalDaylightSamples: dates.length,
    intervalMinutes: stepMin,
    label: monthsLabel(months),
  };
}

export function kasJaar(year?: number): TimeSamples {
  return kasMaandSamples([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], year);
}

export function kasWinter(year?: number): TimeSamples {
  // Okt, Nov, Dec, Jan, Feb, Mrt
  return kasMaandSamples([0, 1, 2, 9, 10, 11], year);
}

export function kasGroeiseizoen(year?: number): TimeSamples {
  // Apr, Mei, Jun, Jul, Aug, Sep
  return kasMaandSamples([3, 4, 5, 6, 7, 8], year);
}

const MAAND_NAMEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function monthsLabel(months: number[]): string {
  if (months.length === 12) return 'Hele jaar (12 maanden, 15e)';
  if (months.length === 6 && months.every((m) => [0, 1, 2, 9, 10, 11].includes(m))) return 'Winter (okt-mrt)';
  if (months.length === 6 && months.every((m) => [3, 4, 5, 6, 7, 8].includes(m)))
    return 'Groeiseizoen (apr-sep)';
  return months.map((m) => MAAND_NAMEN[m]).join(', ');
}
