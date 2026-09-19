import type { Metadata, Viewport } from 'next';
import './globals.css';
import '@xterm/xterm/css/xterm.css';
import { SessionProvider } from './context/SessionContext';
import GlobalVoiceRecorder from './components/GlobalVoiceRecorder';
import SessionView from './components/SessionView';
import WakeLock from './components/WakeLock';
import RightGutter from './components/RightGutter';
import RemoteNavigator from './components/RemoteNavigator';

export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#FF6600',
};

export const metadata: Metadata = {
  title: 'Homestead - Build from Anywhere',
  description: 'Build and tend your digital homestead',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Homestead',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/icon-192.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <SessionProvider>
          <WakeLock />
          <RemoteNavigator />
          {children}
          <SessionView />
          <RightGutter />
          <GlobalVoiceRecorder />
        </SessionProvider>
      </body>
    </html>
  );
}
