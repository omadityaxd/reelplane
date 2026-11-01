import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Reelplane",
  description: "Open-source Reels SDK and video backend.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the iPhone notch and home indicator; the feed pads with safe-area insets.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f5" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

const globalStyles = `
  html, body { margin: 0; height: 100%; background: #f4f4f5; color: #18181b; }
  @media (prefers-color-scheme: dark) { html, body { background: #09090b; color: #f4f4f5; } }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{globalStyles}</style>
        {children}
      </body>
    </html>
  );
}
