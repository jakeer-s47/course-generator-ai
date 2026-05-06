import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://chapter-ai.app"),
  title: {
    default: "Course Generator AI — Turn long lectures into polished micro-lessons",
    template: "%s · Course Generator AI",
  },
  description:
    "Upload a lecture recording. Get back a clean transcript, 20-minute topic-segmented clips, and avatar-narrated videos ready to share with your students.",
  applicationName: "Course Generator AI",
  keywords: [
    "lecture to video",
    "transcription",
    "avatar narration",
    "topic segmentation",
    "educational AI",
    "lecture repurposing",
  ],
  openGraph: {
    type: "website",
    title: "Course Generator AI — Turn long lectures into polished micro-lessons",
    description:
      "Upload one long recording. Get back clean, topic-segmented, avatar-narrated micro-lessons.",
    siteName: "Course Generator AI",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Course Generator AI — Long lectures, distilled.",
    description:
      "Clean transcripts, 20-min topic chunks, avatar-narrated videos. From one recording.",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#6366f1",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
