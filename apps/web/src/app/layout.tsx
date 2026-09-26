import type { Metadata } from 'next';
import { JetBrains_Mono, Poppins } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Liame',
  description: 'Sua agência de marketing com funcionários de IA.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={`${poppins.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
