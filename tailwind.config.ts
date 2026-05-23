import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', '-apple-system', 'sans-serif'],
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(100%)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.4s ease-out forwards',
        'slide-up': 'slideUp 0.3s ease-out forwards',
      },
      colors: {
        brand: {
          DEFAULT: '#6C2BD9',
          50: '#F5F0FF',
          100: '#EDE5FF',
          200: '#D4BBFF',
          300: '#B794F6',
          400: '#9F67FF',
          500: '#6C2BD9',
          600: '#5A22B8',
          700: '#481A97',
          800: '#361376',
          900: '#240D55',
        },
        accent: {
          DEFAULT: '#F59E0B',
          400: '#FBBF24',
          500: '#F59E0B',
          600: '#D97706',
        },
        whatsapp: '#25D366',
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
    },
  },
  plugins: [],
};
export default config;
