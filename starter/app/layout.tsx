import type { ReactNode } from "react";
import { Shell } from "@eliasstravik/gtm/ui";

export const metadata = { title: "GTM Console" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
