import { gtm } from "@eliasstravik/gtm/api";
import { workflows } from "../../../../workflows";

export const dynamic = "force-dynamic";
export const { GET, POST } = gtm({ workflows });
