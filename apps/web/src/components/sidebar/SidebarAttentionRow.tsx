import { useLocation, useNavigate } from "@tanstack/react-router";
import { T } from "gt-react";
import { BellIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useAttentionModel } from "../attention/useAttentionModel";
import { useSidebar } from "../ui/sidebar";

/** Opens Attention from the top of the sidebar, with the count of what needs the user. */
export function SidebarAttentionRow() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useLocation({ select: (location) => location.pathname === "/attention" });
  const model = useAttentionModel();
  const count = model.now.length + model.overflow.length;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/attention" });
      }}
      className={cn(
        "mt-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset",
        active && "bg-sidebar-row-hover text-sidebar-foreground",
      )}
    >
      <BellIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
      <span className="min-w-0 flex-1 truncate">
        <T>Working board</T>
      </span>
      {count > 0 ? (
        <span className="rounded-full bg-primary px-1.5 text-xs leading-4.5 font-medium text-primary-foreground tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  );
}
