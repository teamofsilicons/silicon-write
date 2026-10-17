"use client";

/**
 * The signed-in workspace: a slim horizontal navigation bar, the page, and the ⌘K palette.
 * Below 900 px navigation moves into a menu sheet. The account and search stay within reach.
 *
 * The workspace layout (a Server Component) has already checked the session, so the shell renders signed in from its
 * first frame: no loading flash, no client-side "who am I" request.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ViewTransition, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { BookOpen, CircleUserRound, LogOut, Menu, Search, Store } from "lucide-react";
import { Drawer, DrawerContent } from "@/components/silicon-ui/drawer/drawer";
import { BRAND_NAME, Wordmark } from "@/components/foundation/brand/app-mark";
import type { SessionAccount } from "@/lib/account";
import { appConfig } from "@/lib/app.config";
import { useSignOut } from "@/lib/client/session";
import { openCommandPalette, toggleCommandPalette, useRegisterCommands } from "@/lib/commands";
import { navigationType, navItemFor } from "@/lib/navigation";
import { notifyError } from "@/lib/notify";
import { AccountMenu } from "./account-menu";
import { CommandMenu } from "./command-menu";
import { NavList, OutsideLinks } from "./nav-list";
import styles from "./shell.module.css";

const subscribeNothing = () => () => undefined;

function detectApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

const PAGE_CLASSES = { "nav-forward": "page-forward", "nav-back": "page-back", "nav-fade": "page-fade", default: "page-fade" };

export interface AppShellProps {
  account: SessionAccount;
  /** Silicon Accounts' public origin: "Your account" opens it. */
  accountsUrl: string;
  children: ReactNode;
}

export function AppShell({ account, accountsUrl, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useSignOut();
  const isApple = useSyncExternalStore(subscribeNothing, detectApple, () => false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const section = navItemFor(pathname);

  // The top bar shows a hairline once the page scrolls under it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘K (Ctrl K) toggles the palette.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useRegisterCommands(() => [
    ...appConfig.nav.map(item => {
      const Icon = item.icon;
      return { id: `go.${item.href}`, label: item.label, group: "Go to", icon: <Icon size={16} strokeWidth={1.75} />, keywords: item.keywords, run: () => router.push(item.href, { transitionTypes: [navigationType(window.location.pathname, item.href)] }) };
    }),
    { id: "go.docs", label: `${appConfig.name} docs`, description: "Opens in a new tab", group: "Go to", icon: <BookOpen size={16} strokeWidth={1.75} />, keywords: ["docs", "help", "guide"], run: () => void window.open(appConfig.links.docs, "_blank", "noopener") },
    { id: "go.store", label: "Write in the Silicon Apps store", description: "Opens in a new tab", group: "Go to", icon: <Store size={16} strokeWidth={1.75} />, keywords: ["store", "install", "cli"], run: () => void window.open(appConfig.links.store, "_blank", "noopener") },
    { id: "go.account", label: "Your account", description: "Silicon Accounts, in a new tab", group: "Go to", icon: <CircleUserRound size={16} strokeWidth={1.75} />, keywords: ["account", "profile", "photo"], run: () => void window.open(accountsUrl, "_blank", "noopener") },
    { id: "account.signout", label: "Sign out", description: `Sign this browser out of ${appConfig.name}`, group: "Account", icon: <LogOut size={16} strokeWidth={1.75} />, keywords: ["logout", "log out", "sign out"], run: () => void signOut().catch(failure => notifyError(failure, "Could not sign out")) },
  ], [router, accountsUrl, signOut]);

  return (
    <div className={styles.shell}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <div className={styles.column}>
        <header className={styles.top} data-vt="topbar" data-scrolled={scrolled ? "" : undefined}>
          <div className={styles.topStart}>
            <button type="button" data-sq="surface" className={`${styles.iconButton} ${styles.menuButton}`} onClick={() => setMenuOpen(true)} aria-label="Open the menu" aria-expanded={menuOpen}>
              <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <Link href={appConfig.home} data-sq="surface" className={styles.brand} aria-label={`${BRAND_NAME}, home`}>
              <Wordmark />
            </Link>
            <nav className={styles.desktopNav} aria-label={appConfig.name}>
              <NavList id="header" />
              <a className={styles.guideLink} href={appConfig.links.docs} target="_blank" rel="noopener" data-sq="surface">Docs<span className="sr-only"> (opens in a new tab)</span></a>
            </nav>
          </div>
          <div className={styles.topEnd}>
            <button data-sq="surface" type="button" className={styles.search} onClick={openCommandPalette} aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}>
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className={styles.searchLabel}>Search and jump</span>
              <kbd data-sq="surface">{isApple ? "⌘ K" : "Ctrl K"}</kbd>
            </button>
            <AccountMenu account={account} accountsUrl={accountsUrl} isApple={isApple} />
          </div>
        </header>

        <main id="main" className={styles.main} tabIndex={-1}>
          <ViewTransition key={section?.href ?? pathname} enter={PAGE_CLASSES} exit={PAGE_CLASSES} default="none">
            <div className={styles.page}>{children}</div>
          </ViewTransition>
        </main>
      </div>

      <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
        <DrawerContent side="left" title={appConfig.name} description={appConfig.tagline} className={styles.sheet}>
          <nav className={styles.sheetNav} aria-label={`${appConfig.name} menu`}>
            <NavList id="sheet" onNavigate={() => setMenuOpen(false)} />
            <OutsideLinks />
          </nav>
          <p className={styles.sheetFoot}>Signed in as {account.id} with Silicon Accounts.</p>
        </DrawerContent>
      </Drawer>
      <CommandMenu />
    </div>
  );
}
