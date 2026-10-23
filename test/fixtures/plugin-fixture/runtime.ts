import type { Runtime } from "@eliasstravik/gtm";

export type Api = { greet(name: string): string };
export const bind = (rt: Runtime): Api => ({ greet: (name) => `hello ${name} from ${rt.plugin}` });
