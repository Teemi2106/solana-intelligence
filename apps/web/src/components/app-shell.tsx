import Link from "next/link";
import type { Route } from "next";

const primary = [["Overview", "/dashboard", "⌁"], ["Wallets", "/wallets", "⬡"], ["Signals", "/signals", "◇"], ["Research", "/research", "⌬"]] as const;
const system = [["Status", "/system", "◉"]] as const;

export function AppShell({ children, user }: { children: React.ReactNode; user: string }) {
  return <div className="app-frame">
    <header className="topbar"><Link className="brand" href="/dashboard"><span className="brand-mark">◆</span><b>Degen Scout</b><small>Beta</small></Link><div className="global-search"><span>⌕</span><span>Search wallet, token, or transaction…</span><kbd>/</kbd></div><div className="topbar-state"><i /> System secured</div><div className="user-orb" title={`Signed in as ${user}`}>{user.slice(0, 1).toUpperCase()}</div></header>
    <aside className="sidebar"><NavGroup label="Intelligence" items={primary} /><NavGroup label="System" items={system} /><div className="sidebar-status"><span><i /> Observation mode</span><p>No trading or execution</p></div><div className="sidebar-footer"><div className="mini-mark">DS</div><div><strong>Degen Scout</strong><p>Solana intelligence</p></div></div></aside>
    <main className="app-main">{children}</main>
  </div>;
}

function NavGroup({ label, items }: { label: string; items: readonly (readonly [string, string, string])[] }) { return <div className="nav-group"><p>{label}</p><nav>{items.map(([name, href, icon]) => <Link href={href as Route} key={href}><i>{icon}</i><span>{name}</span></Link>)}</nav></div>; }
