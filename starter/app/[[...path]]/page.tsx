import { notFound } from "next/navigation";
import { Cockpit } from "@eliasstravik/gtm/ui";

const VIEWS = ["context", "workflows", "data", "connections"];

export default async function Page({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  if (path.length > 1 || (path.length === 1 && !VIEWS.includes(path[0]))) notFound();
  return <Cockpit path={path} />;
}
