import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#08090a",
        foreground: "#ededed",
        card: {
          DEFAULT: "rgba(18, 19, 23, 0.75)",
          border: "rgba(255, 255, 255, 0.08)",
          hover: "rgba(28, 30, 36, 0.85)",
        },
        brand: {
          DEFAULT: "#0070f3",
          light: "#3291ff",
          dark: "#0051b3",
          glow: "rgba(0, 112, 243, 0.25)",
        },
        success: {
          DEFAULT: "#10b981",
          glow: "rgba(16, 185, 129, 0.2)",
        },
        warning: {
          DEFAULT: "#f59e0b",
          glow: "rgba(245, 158, 11, 0.2)",
        },
        danger: {
          DEFAULT: "#ef4444",
          glow: "rgba(239, 68, 68, 0.2)",
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "radial-highlight": "radial-gradient(circle at 50% 0%, rgba(0, 112, 243, 0.15), transparent 70%)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "spin-slow": "spin 3s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
