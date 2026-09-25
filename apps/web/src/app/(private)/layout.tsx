import { AppShell } from "../../components/app-shell";
import { requireAdmin } from "../../lib/current-user";

export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin();
  return <AppShell user={user.subject}>{children}</AppShell>;
}
