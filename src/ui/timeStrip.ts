import { getDayRange } from '../sun/sunPosition';

export interface TimeStripOptions {
  initialDate: Date;
  onChange: (date: Date) => void;
}

export interface TimeStrip {
  setDate(date: Date): void;
  current(): Date;
}

/**
 * Onderste strip: dag-van-jaar slider + tijd-slider + play-knop + "nu"-knop.
 * Gebruikt eenvoudige <input type="range"> elementen, geen lib.
 */
export function buildTimeStrip(host: HTMLElement, opts: TimeStripOptions): TimeStrip {
  let current = new Date(opts.initialDate);
  let playing = false;
  let playStart = 0;
  let playStartHours = 0;
  // Hoeveel echte seconden = 1 simulatie-dag
  const SPEED_PRESETS: Array<{ label: string; secondsPerDay: number }> = [
    { label: 'Hyper-snel (3s/dag)', secondsPerDay: 3 },
    { label: 'Heel snel (8s/dag)', secondsPerDay: 8 },
    { label: 'Snel (15s/dag)', secondsPerDay: 15 },
    { label: 'Normaal (30s/dag)', secondsPerDay: 30 },
    { label: 'Langzaam (1m/dag)', secondsPerDay: 60 },
    { label: 'Heel langzaam (3m/dag)', secondsPerDay: 180 },
    { label: 'Sluipend (10m/dag)', secondsPerDay: 600 },
  ];
  const DEFAULT_SPEED_INDEX = 3; // Normaal
  let secondsPerDay = SPEED_PRESETS[DEFAULT_SPEED_INDEX].secondsPerDay;

  host.innerHTML = '';

  // Datum-slider (1..366 = doy)
  const dateGroup = makeGroup('Datum');
  const dateInput = document.createElement('input');
  dateInput.type = 'range';
  dateInput.min = '1';
  dateInput.max = '366';
  const dateValue = document.createElement('span');
  dateValue.className = 'value';
  dateGroup.append(dateInput, dateValue);

  // Tijd-slider (in minuten van zonsopkomst tot zonsondergang voor die datum)
  const timeGroup = makeGroup('Tijd');
  const timeInput = document.createElement('input');
  timeInput.type = 'range';
  timeInput.min = '0';
  timeInput.max = '24';
  timeInput.step = '0.05';
  const timeValue = document.createElement('span');
  timeValue.className = 'value';
  timeGroup.append(timeInput, timeValue);

  // Knoppen
  const playBtn = document.createElement('button');
  playBtn.textContent = '▶ Speel dag af';

  const speedSel = document.createElement('select');
  speedSel.title = 'Afspeelsnelheid';
  SPEED_PRESETS.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p.label;
    if (i === DEFAULT_SPEED_INDEX) opt.selected = true;
    speedSel.appendChild(opt);
  });
  speedSel.addEventListener('change', () => {
    const newSpeed = SPEED_PRESETS[Number(speedSel.value)].secondsPerDay;
    if (playing) {
      // Anchor: huidige tijd → nieuwe playStart zodat scrubbing geen sprong maakt
      const currentHours = Number(timeInput.value);
      playStartHours = currentHours;
      playStart = performance.now();
    }
    secondsPerDay = newSpeed;
    playBtn.title = `1 dag in ${secondsPerDay}s`;
  });
  playBtn.title = `1 dag in ${secondsPerDay}s`;

  const nowBtn = document.createElement('button');
  nowBtn.textContent = '📍 Vandaag, nu';

  host.append(dateGroup, timeGroup, playBtn, speedSel, nowBtn);

  function syncFromDate() {
    const doy = dayOfYear(current);
    dateInput.value = String(doy);
    const hours = current.getHours() + current.getMinutes() / 60 + current.getSeconds() / 3600;
    timeInput.value = String(hours);
    renderLabels();
  }

  function renderLabels() {
    const datum = current.toLocaleDateString('nl-NL', {
      day: 'numeric',
      month: 'short',
      weekday: 'short',
    });
    dateValue.textContent = datum;
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const dr = getDayRange(current);
    const sunHM = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    timeValue.textContent = `${hh}:${mm}  (☀${sunHM(dr.sunrise)}–${sunHM(dr.sunset)})`;
  }

  function emit() {
    opts.onChange(new Date(current));
  }

  dateInput.addEventListener('input', () => {
    const doy = Number(dateInput.value);
    setDayOfYear(current, doy);
    renderLabels();
    emit();
  });

  timeInput.addEventListener('input', () => {
    const hours = Number(timeInput.value);
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    current.setHours(h, m, 0, 0);
    renderLabels();
    emit();
  });

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.classList.toggle('playing', playing);
    playBtn.textContent = playing ? '⏸ Pauze' : '▶ Speel dag af';
    if (playing) {
      playStartHours = Number(timeInput.value);
      playStart = performance.now();
      requestAnimationFrame(playStep);
    }
  });

  function playStep(now: number) {
    if (!playing) return;
    const elapsedSec = (now - playStart) / 1000;
    let hours = playStartHours + (elapsedSec / secondsPerDay) * 24;
    // Wrap binnen 0..24 (dag herstart loopt door naar dag erna? we wrappen op de uur-as)
    hours = ((hours % 24) + 24) % 24;
    timeInput.value = String(hours);
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    current.setHours(h, m, 0, 0);
    renderLabels();
    emit();
    requestAnimationFrame(playStep);
  }

  nowBtn.addEventListener('click', () => {
    current = new Date();
    syncFromDate();
    emit();
  });

  syncFromDate();

  return {
    setDate(date) {
      current = new Date(date);
      syncFromDate();
      emit();
    },
    current() {
      return new Date(current);
    },
  };
}

function makeGroup(label: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'slider-group';
  const lab = document.createElement('label');
  lab.textContent = label;
  div.appendChild(lab);
  return div;
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86400000) + 1;
}

function setDayOfYear(d: Date, doy: number): void {
  const start = new Date(d.getFullYear(), 0, 1, d.getHours(), d.getMinutes());
  d.setTime(start.getTime() + (doy - 1) * 86400000);
}
