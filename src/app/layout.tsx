import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Collection — Funil de Conversão",
  description: "Dashboard de funil de conversão da Collection",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
