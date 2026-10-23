"use client";
import type { TabProps } from "@eliasstravik/gtm/ui";

export default function FixtureTab({ workflow }: TabProps) {
  return <p>Fixture tab for {workflow.name}</p>;
}
