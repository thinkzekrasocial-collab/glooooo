import type { ReactNode } from "react";
import { AppSessionLayout } from "./AppSessionLayout";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppSessionLayout>{children}</AppSessionLayout>;
}
