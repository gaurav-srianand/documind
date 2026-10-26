import "./globals.css";

export const metadata = {
  title: "DocuMind",
  description: "AI-powered PDF question answering with retrieval-augmented generation",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
