import type { ReactNode } from "react";
import { Shell } from "@eliasstravik/gtm/ui";

export const metadata = { title: "GTM cockpit" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
