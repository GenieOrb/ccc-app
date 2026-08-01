import type { Metadata } from 'next';
import { Fredoka, Nunito } from 'next/font/google';
import './globals.css';

const fredoka = Fredoka({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-fredoka',
  display: 'swap',
});

const nunito = Nunito({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-nunito',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ccc-app',
  description: 'ccc-app',
  openGraph: {
    title: 'ccc-app',
    description: 'ccc-app',
  },
  twitter: {
    title: 'ccc-app',
    description: 'ccc-app',
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${fredoka.variable} ${nunito.variable}`}>
      <head>
        <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
