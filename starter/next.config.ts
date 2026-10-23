import { withGtm } from "@eliasstravik/gtm/next";
import manifest from "./gtm/manifest";
import transforms, { trace } from "./gtm/next";

export default withGtm({}, { manifest, transforms, trace });
