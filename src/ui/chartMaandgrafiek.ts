import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Title,
  type ChartConfiguration,
} from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Title);

export interface MaandPoint {
  /** 0=jan ... 11=dec */
  month: number;
  /** Direct zon-uren op de 15e van die maand. */
  sunHours: number;
  /** Daglicht-uren op die dag. */
  daylightHours: number;
}

const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/**
 * Bar chart: per maand het aantal direct-zon-uren op een specifieke plek.
 * Goud = sunhours, transparante achtergrond = daglicht-uren.
 */
export function renderMaandGrafiek(
  container: HTMLElement,
  title: string,
  points: MaandPoint[],
): Chart {
  container.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.style.maxWidth = '100%';
  container.appendChild(canvas);

  const config: ChartConfiguration = {
    type: 'bar',
    data: {
      labels: points.map((p) => MAANDEN[p.month]),
      datasets: [
        {
          label: 'Daglicht (h)',
          data: points.map((p) => p.daylightHours),
          backgroundColor: 'rgba(140, 140, 160, 0.25)',
          borderWidth: 0,
          stack: 'a',
        },
        {
          label: 'Direct zon (h)',
          data: points.map((p) => p.sunHours),
          backgroundColor: 'rgba(255, 180, 84, 0.92)',
          borderWidth: 0,
          stack: 'b',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: title,
          color: '#e6edf3',
          font: { size: 13, weight: 'normal' },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${(ctx.parsed.y ?? 0).toFixed(1)}h`,
          },
        },
        legend: {
          display: true,
          labels: { color: '#8b949e', font: { size: 10 }, boxWidth: 10 },
        },
      },
      scales: {
        x: {
          stacked: false,
          ticks: { color: '#8b949e', font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          stacked: false,
          ticks: { color: '#8b949e', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: 'uren', color: '#8b949e', font: { size: 10 } },
        },
      },
    },
  };
  return new Chart(canvas, config);
}
