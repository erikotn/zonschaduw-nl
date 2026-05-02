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

export interface UurCurvePoint {
  hour: number;
  inSun: boolean;
}

/**
 * Render een bar-chart van de uur-curve in de gegeven container.
 * Zon-uren = goud, schaduw-uren = grijs.
 */
export function renderUurCurve(
  container: HTMLElement,
  title: string,
  curve: UurCurvePoint[],
): Chart {
  container.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.style.maxWidth = '100%';
  container.appendChild(canvas);

  const config: ChartConfiguration = {
    type: 'bar',
    data: {
      labels: curve.map((p) => `${String(Math.floor(p.hour)).padStart(2, '0')}:${String(Math.round((p.hour - Math.floor(p.hour)) * 60)).padStart(2, '0')}`),
      datasets: [
        {
          label: 'Zon (1) / schaduw (0)',
          data: curve.map((p) => (p.inSun ? 1 : 0)),
          backgroundColor: curve.map((p) =>
            p.inSun ? 'rgba(255, 180, 84, 0.85)' : 'rgba(140, 140, 160, 0.55)',
          ),
          borderWidth: 0,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
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
            label: (ctx) => ((ctx.parsed.y ?? 0) > 0 ? '☀ Zon' : '⛅ Schaduw'),
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#8b949e',
            font: { size: 10 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
          },
          grid: { display: false },
        },
        y: {
          display: false,
          min: 0,
          max: 1.05,
        },
      },
    },
  };
  return new Chart(canvas, config);
}
