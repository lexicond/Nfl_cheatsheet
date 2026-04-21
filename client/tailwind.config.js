/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0f1117',
        surface: '#1a1d27',
        'surface-2': '#222535',
        border: '#2e3148',
        'text-primary': '#e8eaf0',
        'text-secondary': '#8b90a8',
        'text-muted': '#555875',
        qb: '#f59e0b',
        rb: '#22c55e',
        wr: '#3b82f6',
        te: '#f97316',
        kdef: '#6b7280',
        tier1: '#f59e0b',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
