import './globals.css';

export const metadata = {
  title: 'Conversor de Extratos Bancários',
  description: 'PDF do extrato → Planilha Excel — Qualquer banco',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
