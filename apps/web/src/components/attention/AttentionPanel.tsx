import { useAtomValue } from "@effect/atom-react";
import { buildPendingUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import {
  attentionMatcherFor,
  type AttentionGroup,
  type RankedAttention,
} from "@t3tools/client-runtime/state/attention-ranking";
import type { AttentionThreadAsk } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  BellIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  SendIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Atom, AsyncResult } from "effect/reactivity";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { attentionEnvironment } from "../../state/attention";
import { useProjects } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel, formatShortTimestamp } from "../../timestampFormat";
import { ATTENTION_PANEL_MIN_HEIGHT, useUiStateStore } from "../../uiStateStore";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { usePullRequestHandoffs } from "../pullRequest/usePullRequestActions";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { SnoozeMenuButton } from "../sidebar/SidebarThreadRow";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { attentionAskLine, attentionKindLabel, attentionReasonLine } from "./attentionLabels";
import { handToAgentPrompt, type AttentionEntry, type RunningEntry } from "./AttentionPanel.logic";
import { useAttentionActions, type AttentionActions } from "./useAttentionActions";
import { useAttentionModel, type AttentionModel } from "./useAttentionModel";

type RankedEntry = RankedAttention<AttentionEntry["payload"]>;
type Group = AttentionGroup<AttentionEntry["payload"]>;

/** Ignoring an item counts only once it sat in Now this long without an action. */
const IGNORED_AFTER_MS = 30_000;
const MAX_HEIGHT_FRACTION = 0.8;

/** Docked at the bottom of the sidebar: what needs the user, what is running, what waits. */
export function AttentionPanel() {
  const gt = useGT();
  const navigate = useNavigate();
  const collapsed = useUiStateStore((state) => state.attentionPanelCollapsed);
  const height = useUiStateStore((state) => state.attentionPanelHeight);
  const setCollapsed = useUiStateStore((state) => state.setAttentionPanelCollapsed);
  const model = useAttentionModel();
  const needCount = model.now.length + model.overflow.length;

  return (
    <section
      aria-label={gt("Attention")}
      data-attention-panel
      className="relative flex shrink-0 flex-col border-t border-sidebar-border"
      style={collapsed ? undefined : { height }}
    >
      {collapsed ? null : <ResizeHandle />}
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-sidebar-muted-foreground hover:text-sidebar-foreground"
        >
          {collapsed ? (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <BellIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            <T>Attention</T>
          </span>
          {needCount > 0 ? (
            <span className="rounded-full bg-accent px-1.5 text-3xs tabular-nums text-sidebar-foreground">
              {needCount}
            </span>
          ) : null}
          {model.running.length > 0 ? (
            <span className="truncate text-3xs font-normal">
              {gt("{count} running", { count: model.running.length })}
            </span>
          ) : null}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-micro"
                aria-label={gt("Attention settings")}
                onClick={() => void navigate({ to: "/settings/threads", hash: "attention" })}
              />
            }
          >
            <Settings2Icon />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Attention settings</T>
          </TooltipPopup>
        </Tooltip>
      </div>
      {collapsed ? null : <AttentionBody model={model} />}
    </section>
  );
}

function ResizeHandle() {
  const setHeight = useUiStateStore((state) => state.setAttentionPanelHeight);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (panel === null) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const maxHeight = window.innerHeight * MAX_HEIGHT_FRACTION;
    const onMove = (move: PointerEvent) => {
      const next = Math.min(
        maxHeight,
        Math.max(ATTENTION_PANEL_MIN_HEIGHT, startHeight + startY - move.clientY),
      );
      panel.style.height = `${next}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setHeight(panel.getBoundingClientRect().height);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
    />
  );
}

function AttentionBody({ model }: { model: AttentionModel }) {
  const gt = useGT();
  const actedIds = useRef(new Set<string>());
  const actions = useAttentionActions((entry) => actedIds.current.add(entry.id));
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [showOverflow, setShowOverflow] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const groups = showOverflow ? [...model.now, ...model.overflow] : model.now;
  const visibleEntries = groups.flatMap((group) =>
    group.members.length > 1 && expandedGroups.has(group.lead.id) ? group.members : [group.lead],
  );
  useIgnoredTracking(model.now, actions, actedIds);

  const selected = visibleEntries.find((entry) => entry.id === selectedId) ?? null;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [role=menu]") || event.metaKey || event.ctrlKey) return;
    const index = selected === null ? -1 : visibleEntries.indexOf(selected);
    const move = (to: number) => {
      const next = visibleEntries[Math.max(0, Math.min(visibleEntries.length - 1, to))];
      if (next === undefined) return;
      setSelectedId(next.id);
      event.currentTarget
        .querySelector<HTMLElement>(`[data-attention-row="${CSS.escape(next.id)}"]`)
        ?.focus();
    };
    switch (event.key) {
      case "j":
      case "ArrowDown":
        move(index + 1);
        break;
      case "k":
      case "ArrowUp":
        move(index - 1);
        break;
      case "Enter":
        if (selected) void actions.open(selected);
        break;
      case "d":
        if (selected) actions.dismiss(selected);
        break;
      case "a":
        // The row holds the ask that approving needs, so press its own button.
        event.currentTarget
          .querySelector<HTMLButtonElement>(
            `[data-attention-row="${CSS.escape(selected?.id ?? "")}"] [data-attention-approve]`,
          )
          ?.click();
        break;
      case "s": {
        if (!selected) break;
        const [first] = resolveSnoozePresets(
          new Date(),
          timestampFormat,
          selected.payload.environmentId,
        );
        if (first) actions.snooze(selected, first.snoozedUntil);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const empty = model.now.length === 0 && model.running.length === 0 && model.later.length === 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 text-xs" onKeyDown={onKeyDown}>
      {empty ? (
        <p className="px-2 py-3 text-sidebar-muted-foreground">
          <T>Nothing needs you right now.</T>
        </p>
      ) : null}
      {model.now.length > 0 ? (
        <SectionLabel>
          <T>Now</T>
        </SectionLabel>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {groups.map((group) => (
          <GroupRows
            key={group.lead.id}
            group={group}
            expanded={expandedGroups.has(group.lead.id)}
            onToggle={() =>
              setExpandedGroups((current) => {
                const next = new Set(current);
                if (!next.delete(group.lead.id)) next.add(group.lead.id);
                return next;
              })
            }
            selectedId={selectedId}
            tabbableId={selectedId ?? visibleEntries[0]?.id ?? null}
            onSelect={setSelectedId}
            actions={actions}
            nowMs={model.nowMs}
          />
        ))}
      </ul>
      {model.overflow.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowOverflow(!showOverflow)}
          className="mt-0.5 w-full cursor-pointer rounded-md px-2 py-1 text-left text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          {showOverflow
            ? gt("Show fewer")
            : gt("{count, plural, one {# more needs you} other {# more need you}}", {
                count: model.overflow.length,
              })}
        </button>
      ) : null}
      {model.running.length > 0 ? (
        <>
          <SectionLabel>
            <T>Running</T>
          </SectionLabel>
          <ul className="flex flex-col">
            {model.running.map((entry) => (
              <RunningRow key={entry.id} entry={entry} nowMs={model.nowMs} />
            ))}
          </ul>
        </>
      ) : null}
      {model.later.length > 0 || model.muted.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={laterOpen}
            onClick={() => setLaterOpen(!laterOpen)}
            className="mt-2 flex w-full cursor-pointer items-center gap-1 px-2 text-3xs font-medium tracking-wide text-sidebar-muted-foreground uppercase hover:text-sidebar-foreground"
          >
            {laterOpen ? (
              <ChevronDownIcon aria-hidden className="size-3" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3" />
            )}
            {gt("Later ({count})", { count: model.later.length + model.muted.length })}
          </button>
          {laterOpen ? <LaterRows model={model} actions={actions} /> : null}
        </>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 mb-0.5 px-2 text-3xs font-medium tracking-wide text-sidebar-muted-foreground uppercase first:mt-0">
      {children}
    </div>
  );
}

/**
 * Logs items that sat in Now without an action as ignored, when they leave Now or the panel
 * closes. The decision log lives on the server, outside React.
 */
function useIgnoredTracking(
  now: ReadonlyArray<Group>,
  actions: AttentionActions,
  acted: RefObject<Set<string>>,
) {
  const shownSince = useRef(new Map<string, { at: number; entry: AttentionEntry }>());
  const leadKey = now.map((group) => group.lead.id).join("\n");
  const flush = useEffectEvent((keep: ReadonlySet<string>) => {
    const at = Date.now();
    for (const [id, shown] of shownSince.current) {
      if (keep.has(id)) continue;
      shownSince.current.delete(id);
      const visibleMs = at - shown.at;
      if (!acted.current.delete(id) && visibleMs >= IGNORED_AFTER_MS) {
        actions.ignored(shown.entry, visibleMs);
      }
    }
  });
  const observe = useEffectEvent((ids: ReadonlySet<string>) => {
    for (const group of now) {
      if (!shownSince.current.has(group.lead.id)) {
        shownSince.current.set(group.lead.id, { at: Date.now(), entry: group.lead });
      }
    }
    flush(ids);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- logs items leaving Now to the server's decision log
  useEffect(() => observe(new Set(leadKey.split("\n"))), [leadKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closing the panel ends every visible item's watch
  useEffect(() => () => flush(new Set()), []);
}

function GroupRows(props: {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
  selectedId: string | null;
  tabbableId: string | null;
  onSelect: (id: string) => void;
  actions: AttentionActions;
  nowMs: number;
}) {
  const { group, expanded } = props;
  const gt = useGT();
  if (group.members.length === 1) {
    return (
      <AttentionRow
        entry={group.lead}
        selected={props.selectedId === group.lead.id}
        tabbable={props.tabbableId === group.lead.id}
        onSelect={props.onSelect}
        actions={props.actions}
        nowMs={props.nowMs}
      />
    );
  }
  const childCount = group.members.filter((member) => member.id !== group.lead.id).length;
  const summary = gt("{needing} of {total} subthreads need you", {
    needing: childCount,
    total: group.descendantCount,
  });
  return (
    <li>
      <AttentionRow
        entry={group.lead}
        selected={props.selectedId === group.lead.id}
        tabbable={props.tabbableId === group.lead.id}
        onSelect={props.onSelect}
        actions={props.actions}
        nowMs={props.nowMs}
        rollup={{ summary, expanded, onToggle: props.onToggle }}
      />
      {expanded ? (
        <ul className="ml-3 flex flex-col gap-0.5 border-l border-sidebar-border pl-1">
          {group.members
            .filter((member) => member.id !== group.lead.id)
            .map((member) => (
              <AttentionRow
                key={member.id}
                entry={member}
                selected={props.selectedId === member.id}
                tabbable={props.tabbableId === member.id}
                onSelect={props.onSelect}
                actions={props.actions}
                nowMs={props.nowMs}
              />
            ))}
        </ul>
      ) : null}
    </li>
  );
}

const NO_ASK: AttentionThreadAsk = { text: null, generated: false };
const NO_ASK_ATOM = Atom.make(AsyncResult.success(NO_ASK)).pipe(Atom.keepAlive);

/** The thread's ask, read once per need. Items from server sources carry their own detail. */
function useThreadAsk(entry: AttentionEntry): AttentionThreadAsk | null {
  const payload = entry.payload;
  const result = useAtomValue(
    payload.type === "thread"
      ? attentionEnvironment.threadAsk({
          environmentId: payload.environmentId,
          input: { threadId: payload.shell.id, key: payload.askKey },
        })
      : NO_ASK_ATOM,
  );
  return payload.type === "thread" ? AsyncResult.getOrElse(result, () => NO_ASK) : null;
}

function AttentionRow(props: {
  entry: RankedEntry;
  selected: boolean;
  tabbable: boolean;
  onSelect: (id: string) => void;
  actions: AttentionActions;
  nowMs: number;
  rollup?: { summary: string; expanded: boolean; onToggle: () => void };
}) {
  const { entry, actions } = props;
  const gt = useGT();
  const messages = useMessages();
  const payload = entry.payload;
  const ask = useThreadAsk(entry);
  const title = payload.type === "thread" ? payload.shell.title : payload.item.title;
  const detail = payload.type === "thread" ? (ask?.text ?? null) : payload.item.detail;
  const askLine =
    payload.type === "item"
      ? `${attentionKindLabel(entry.kind, messages)}${payload.item.author ? ` · @${payload.item.author}` : ""}`
      : attentionAskLine(entry.kind, detail, messages);
  const Icon =
    payload.type === "item"
      ? PullRequestGlyph.pullRequest
      : ask?.generated
        ? BotIcon
        : MessageSquareIcon;
  return (
    <li
      data-attention-row={entry.id}
      tabIndex={props.tabbable ? 0 : -1}
      onFocus={() => props.onSelect(entry.id)}
      className={cn(
        "group/attention flex flex-col gap-1 rounded-md px-2 py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        props.selected && "bg-sidebar-row-hover",
      )}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <button
          type="button"
          onClick={() => void actions.open(entry)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <div className="truncate font-medium text-sidebar-foreground">{title}</div>
          <div className="truncate text-sidebar-muted-foreground">
            {props.rollup ? props.rollup.summary : askLine}
          </div>
        </button>
        <span className="shrink-0 pt-px text-3xs text-sidebar-muted-foreground tabular-nums">
          {formatElapsedDurationLabel(entry.since, props.nowMs)}
        </span>
        <WhyShown entry={entry} />
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-5">
        {props.rollup ? (
          <Button size="micro" variant="outline" onClick={props.rollup.onToggle}>
            {props.rollup.expanded ? gt("Hide subthreads") : gt("Show subthreads")}
          </Button>
        ) : null}
        {payload.type === "thread" ? (
          <ThreadActions entry={entry} ask={ask ?? NO_ASK} actions={actions} />
        ) : (
          <ItemActions entry={entry} actions={actions} />
        )}
        <SnoozeAction entry={entry} actions={actions} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={gt("Dismiss")}
                onClick={() => actions.dismiss(entry)}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {payload.type === "thread" ? <T>Settle thread</T> : <T>Dismiss until it changes</T>}
          </TooltipPopup>
        </Tooltip>
        <MoreMenu entry={entry} actions={actions} />
      </div>
    </li>
  );
}

function WhyShown({ entry }: { entry: RankedEntry }) {
  const gt = useGT();
  const messages = useMessages();
  const signals = entry.payload.type === "item" ? entry.payload.item.signals : [];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={gt("Why this is shown")}
            className="shrink-0 cursor-help text-sidebar-muted-foreground opacity-0 group-hover/attention:opacity-100 focus-visible:opacity-100"
          />
        }
      >
        <CircleHelpIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex max-w-72 flex-col gap-0.5 text-xs">
          <div className="font-medium">
            <T>Why this is shown</T>
          </div>
          {entry.reasons.map((reason, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- reasons have no identity and never reorder
            <div key={index}>{attentionReasonLine(reason, messages)}</div>
          ))}
          {signals.length > 0 ? (
            <div className="text-muted-foreground">{signals.join(" · ")}</div>
          ) : null}
          <div className="text-muted-foreground">{gt("Score {score}", { score: entry.score })}</div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function ThreadActions(props: {
  entry: RankedEntry;
  ask: AttentionThreadAsk;
  actions: AttentionActions;
}) {
  const { entry, ask, actions } = props;
  const gt = useGT();
  if (entry.kind === "approval" && ask.approval?.live) {
    return (
      <>
        <Button
          size="micro"
          data-attention-approve
          onClick={() => void actions.respondApproval(entry, ask, "accept")}
        >
          <CheckIcon />
          <T>Approve</T>
        </Button>
        <Button
          size="micro"
          variant="outline"
          onClick={() => void actions.respondApproval(entry, ask, "decline")}
        >
          <T>Deny</T>
        </Button>
      </>
    );
  }
  if (entry.kind === "input" && ask.input?.live && ask.input.questions.length === 1) {
    return <InlineAnswer entry={entry} ask={ask} actions={actions} />;
  }
  if (entry.kind === "plan" && ask.plan) {
    return (
      <Button size="micro" onClick={() => void actions.acceptPlan(entry, ask)}>
        <T>Accept plan</T>
      </Button>
    );
  }
  return (
    <Button size="micro" variant="outline" onClick={() => void actions.open(entry)}>
      {entry.kind === "input" || entry.kind === "approval" ? gt("Respond") : gt("Open")}
    </Button>
  );
}

function InlineAnswer(props: {
  entry: RankedEntry;
  ask: AttentionThreadAsk;
  actions: AttentionActions;
}) {
  const gt = useGT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const questions = props.ask.input?.questions ?? [];
  const question = questions[0];
  if (question === undefined) return null;
  const send = async (draft: { customAnswer?: string; selectedOptionValues?: string[] }) => {
    const answers = buildPendingUserInputAnswers(questions, { [question.id]: draft });
    if (answers === null) return;
    setSending(true);
    const sent = await props.actions.answer(props.entry, props.ask, answers);
    setSending(false);
    if (sent) setText("");
  };
  return (
    <div className="flex w-full flex-col gap-1">
      {question.options.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {question.options.slice(0, 4).map((option) => (
            <Button
              key={option.value ?? option.label}
              size="micro"
              variant="outline"
              disabled={sending}
              onClick={() => void send({ selectedOptionValues: [option.value ?? option.label] })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {question.allowCustomAnswer ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim().length > 0) void send({ customAnswer: text });
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={gt("Type an answer")}
            aria-label={gt("Answer")}
            disabled={sending}
            className="h-6 min-w-0 flex-1 rounded-sm border border-sidebar-border bg-transparent px-1.5 text-xs outline-none focus:border-ring"
          />
          <Button
            type="submit"
            size="icon-micro"
            variant="ghost"
            aria-label={gt("Send answer")}
            disabled={sending || text.trim().length === 0}
          >
            <SendIcon />
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function ItemActions({ entry, actions }: { entry: RankedEntry; actions: AttentionActions }) {
  const gt = useGT();
  const projects = useProjects();
  const payload = entry.payload;
  const item = payload.type === "item" ? payload.item : null;
  const project =
    item?.projectId == null
      ? undefined
      : projects.find(
          (candidate) =>
            candidate.environmentId === payload.environmentId && candidate.id === item.projectId,
        );
  const handoffs = usePullRequestHandoffs({
    environmentId: payload.environmentId,
    detail:
      project === undefined || item?.url == null
        ? null
        : { projectId: project.id, workspaceRoot: project.workspaceRoot, url: item.url },
  });
  if (item === null) return null;
  const canHandOff = project !== undefined && item.url !== null && item.source === "github";
  return (
    <>
      <Button size="micro" variant="outline" onClick={() => void actions.open(entry)}>
        <ExternalLinkIcon />
        <T>Open</T>
      </Button>
      {canHandOff && item.actions.includes("hand_to_agent") ? (
        <Button
          size="micro"
          variant="outline"
          disabled={handoffs.handoff !== null}
          onClick={() => {
            actions.handedToAgent(entry);
            void handoffs.startHandoff("attention-agent", { prompt: handToAgentPrompt(item) });
          }}
        >
          <BotIcon />
          {gt("Hand to agent")}
        </Button>
      ) : null}
      {canHandOff && item.actions.includes("prepare_thread") ? (
        <Button
          size="micro"
          variant="ghost-muted"
          disabled={handoffs.handoff !== null}
          onClick={() => {
            actions.preparedThread(entry);
            void handoffs.startHandoff("attention-open", null);
          }}
        >
          <T>Open in thread</T>
        </Button>
      ) : null}
    </>
  );
}

function SnoozeAction({ entry, actions }: { entry: RankedEntry; actions: AttentionActions }) {
  const [open, setOpen] = useState(false);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <SnoozeMenuButton
      open={open}
      onOpenChange={setOpen}
      onSnooze={(preset) => actions.snooze(entry, preset.snoozedUntil)}
      timestampFormat={timestampFormat}
      environmentId={entry.payload.environmentId}
    />
  );
}

function MoreMenu({ entry, actions }: { entry: RankedEntry; actions: AttentionActions }) {
  const gt = useGT();
  const mutes = (["author", "repo", "project", "kind"] as const).flatMap((by) => {
    const match = attentionMatcherFor(entry, by);
    return match === null ? [] : [{ by, match }];
  });
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-micro" variant="ghost-muted" aria-label={gt("More actions")} />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        {entry.payload.type === "thread" ? (
          <MenuItem onClick={() => actions.markUnread(entry)}>
            <T>Mark unread</T>
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => actions.feedback(entry, "less")}>
          <T>Not important</T>
        </MenuItem>
        <MenuItem onClick={() => actions.feedback(entry, "more")}>
          <T>More like this</T>
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>
            <T>Mute</T>
          </MenuSubTrigger>
          <MenuSubPopup>
            {mutes.map(({ by, match }) => (
              <MenuItem key={by} onClick={() => actions.mute(entry, match)}>
                {by === "author"
                  ? gt("Everything from {value}", { value: match.author ?? "" })
                  : by === "repo"
                    ? gt("Everything in {value}", { value: match.repo ?? "" })
                    : by === "project"
                      ? gt("Everything in project {value}", { value: match.project ?? "" })
                      : gt("All like this: {value}", { value: match.kind ?? "" })}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}

function RunningRow({ entry, nowMs }: { entry: RunningEntry; nowMs: number }) {
  const gt = useGT();
  const navigate = useNavigate();
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(entry.environmentId, entry.shell.id)),
          })
        }
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-sidebar-row-hover"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            entry.blockedOnWait ? "bg-warning" : "bg-info",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{entry.shell.title}</span>
        {entry.blockedOnWait ? (
          <span className="shrink-0 text-3xs text-warning">{gt("waiting on subthread")}</span>
        ) : null}
        <span className="shrink-0 text-3xs text-sidebar-muted-foreground tabular-nums">
          {formatElapsedDurationLabel(entry.since, nowMs)}
        </span>
      </button>
    </li>
  );
}

function LaterRows({ model, actions }: { model: AttentionModel; actions: AttentionActions }) {
  const gt = useGT();
  const messages = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <ul className="flex flex-col">
      {model.later.map(({ entry, wakeAt }) => (
        <li
          key={entry.id}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-sidebar-row-hover"
        >
          <button
            type="button"
            onClick={() => void actions.open(entry)}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-sidebar-foreground"
          >
            {entry.payload.type === "thread" ? entry.payload.shell.title : entry.payload.item.title}
          </button>
          <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
            {gt("until {time}", { time: formatShortTimestamp(wakeAt, timestampFormat) })}
          </span>
          <Button size="micro" variant="ghost-muted" onClick={() => actions.unsnooze(entry)}>
            <T>Wake</T>
          </Button>
        </li>
      ))}
      {model.muted.map((entry) => {
        const mute = entry.reasons.find((reason) => reason.code === "mute");
        return (
          <li
            key={entry.id}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sidebar-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate">
              {entry.payload.type === "thread"
                ? entry.payload.shell.title
                : entry.payload.item.title}
            </span>
            <span className="shrink-0 text-3xs">{attentionKindLabel(entry.kind, messages)}</span>
            {mute?.code === "mute" ? (
              <Button
                size="micro"
                variant="ghost-muted"
                onClick={() => actions.unmute(entry, mute.match)}
              >
                <T>Unmute</T>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
