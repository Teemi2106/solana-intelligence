import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solana Intelligence",
  description: "Private on-chain wallet intelligence and signal monitoring",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
