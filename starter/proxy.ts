import type { NextRequest } from "next/server";
import { gtmProxy } from "@eliasstravik/gtm/proxy";

export default function proxy(req: NextRequest) {
  return gtmProxy(req);
}

export const config = { matcher: ["/((?!_next/static|_next/image|_gtm/probe.txt|favicon.ico).*)"] };
