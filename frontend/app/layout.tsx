import type { Metadata } from "next";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MegaPot — the confidential no-loss lottery",
  description:
    "Deposit, win the yield, lose nothing — with your balance, your odds, and the winner encrypted end to end by the Zama Protocol.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
