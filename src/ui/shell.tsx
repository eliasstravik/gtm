"use client";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import "./style.css";
import type { ReactNode } from "react";

/** The Console's frame. (Stub until the Shell helper fills it in.) */
export function Shell({ children }: { children: ReactNode }) {
  return <div className="app"><main className="main">{children}</main></div>;
}
