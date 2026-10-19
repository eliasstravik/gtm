import { Console } from "@eliasstravik/gtm/ui";

export default async function Page({ params }: { params: Promise<{ path?: string[] }> }) {
  return <Console path={(await params).path ?? []} />;
}
