import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";

import { Providers } from "./providers";
import "./globals.css";

const sans = Outfit({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "MegaPot — Confidential no-loss lottery",
  description:
    "Deposit, win the yield, lose nothing. Balances, odds, winnings and the winner stay encrypted end to end with the Zama Protocol, with the prize played on the real Megapot jackpot.",
  openGraph: {
    title: "MegaPot — Confidential no-loss lottery",
    description:
      "A no-loss lottery where your balance, your odds and the winner are FHE ciphertexts on-chain.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body style={{ fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
