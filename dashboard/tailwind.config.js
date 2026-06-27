/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          gold: '#C9A227',
          'gold-light': '#E8C547',
          blue: '#1B3A6B',
          'blue-light': '#2E5A9E',
        },
      },
    },
  },
  plugins: [],
};
