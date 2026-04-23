import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import { RootShell } from "@/components/layout/root-shell";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const notoSansJP = Noto_Sans_JP({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "給与計算システム",
  description: "訪問介護事業所向け給与計算ソフト",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${notoSansJP.variable} h-full antialiased`}>
      <body className="h-full flex">
        <RootShell>{children}</RootShell>
        <Toaster />
      </body>
    </html>
  );
}
