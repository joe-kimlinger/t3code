import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";
import { sortKeyedThenNewest } from "./threadSort.ts";

export interface ArrangeableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly createdAt: string;
  readonly arrangedParentThreadId?: ThreadId | null | undefined;
  readonly arrangedOrderKey?: string | null | undefined;
}

export interface ThreadArrangement<T extends ArrangeableThread> {
  /** The listed thread `key` renders under, or null when it is top level. */
  readonly parentKeyOf: (key: string) => string | null;
  /** Children of `key` in sibling order. */
  readonly childrenOf: (key: string) => readonly T[];
}

export interface ArrangedRow<T> {
  readonly thread: T;
  readonly key: string;
  readonly depth: number;
  readonly childCount: number;
}

const NO_CHILDREN: readonly never[] = [];

export const arrangedThreadKey = (thread: Pick<ArrangeableThread, "environmentId" | "id">) =>
  scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });

/**
 * Nests `threads` by their arranged parent, across projects. A parent missing from `threads`
 * (archived, filtered out) leaves the child top level, and a cycle from racing moves is cut.
 */
export function arrangeThreads<T extends ArrangeableThread>(
  threads: readonly T[],
  /** Threads listed at the top level whatever their parent. */
  detachedKeys?: ReadonlySet<string>,
): ThreadArrangement<T> {
  const byKey = new Map<string, T>();
  for (const thread of threads) byKey.set(arrangedThreadKey(thread), thread);
  const parentKeys = new Map<string, string>();
  for (const [key, thread] of byKey) {
    if (thread.arrangedParentThreadId == null || detachedKeys?.has(key)) continue;
    const parentKey = scopedThreadKey({
      environmentId: thread.environmentId,
      threadId: thread.arrangedParentThreadId,
    });
    const parent = byKey.get(parentKey);
    if (parent !== undefined && parentKey !== key) {
      parentKeys.set(key, parentKey);
    }
  }
  // Cut each cycle at the edge that closes it; every walk visits a thread at most once overall.
  const settled = new Set<string>();
  for (const start of parentKeys.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !settled.has(current)) {
      if (onPath.has(current)) {
        parentKeys.delete(path[path.length - 1]!);
        break;
      }
      onPath.add(current);
      path.push(current);
      current = parentKeys.get(current);
    }
    for (const key of path) settled.add(key);
  }
  const children = new Map<string, T[]>();
  for (const [key, parentKey] of parentKeys) {
    const list = children.get(parentKey);
    const thread = byKey.get(key)!;
    if (list === undefined) children.set(parentKey, [thread]);
    else list.push(thread);
  }
  const sortedChildren = new Map<string, readonly T[]>();
  for (const [parentKey, list] of children) {
    sortedChildren.set(
      parentKey,
      sortKeyedThenNewest(list, (thread) => thread.arrangedOrderKey),
    );
  }
  return {
    parentKeyOf: (key) => parentKeys.get(key) ?? null,
    childrenOf: (key) => sortedChildren.get(key) ?? NO_CHILDREN,
  };
}

/**
 * Nests `threads` like `arrangeThreads`, but a thread whose top-level ancestor is parked
 * (settled or snoozed) while it is not stays at the top level, so work that needs the user
 * is never folded away inside a closed shelf.
 */
export function arrangeThreadsKeepingUnparked<T extends ArrangeableThread>(
  threads: readonly T[],
  isParked: (thread: T) => boolean,
): ThreadArrangement<T> {
  const arrangement = arrangeThreads(threads);
  const byKey = new Map(threads.map((thread) => [arrangedThreadKey(thread), thread] as const));
  const rootKeyCache = new Map<string, string>();
  const rootKeyOf = (key: string): string => {
    const cached = rootKeyCache.get(key);
    if (cached !== undefined) return cached;
    const parentKey = arrangement.parentKeyOf(key);
    const rootKey = parentKey === null ? key : rootKeyOf(parentKey);
    rootKeyCache.set(key, rootKey);
    return rootKey;
  };
  const detached = new Set<string>();
  for (const [key, thread] of byKey) {
    if (arrangement.parentKeyOf(key) === null || isParked(thread)) continue;
    const root = byKey.get(rootKeyOf(key));
    if (root !== undefined && isParked(root)) detached.add(key);
  }
  return detached.size === 0 ? arrangement : arrangeThreads(threads, detached);
}

/** Each root followed by its descendants, depth first, skipping those under a collapsed thread. */
export function flattenArrangedThreads<T extends ArrangeableThread>(
  roots: readonly T[],
  arrangement: ThreadArrangement<T>,
  isCollapsed: (key: string) => boolean,
): ArrangedRow<T>[] {
  const rows: ArrangedRow<T>[] = [];
  const visit = (thread: T, depth: number) => {
    const key = arrangedThreadKey(thread);
    const children = arrangement.childrenOf(key);
    rows.push({ thread, key, depth, childCount: children.length });
    if (isCollapsed(key)) return;
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** Every thread nested anywhere under `key`. */
export function arrangedDescendants<T extends ArrangeableThread>(
  key: string,
  arrangement: ThreadArrangement<T>,
): T[] {
  const descendants: T[] = [];
  const stack = [...arrangement.childrenOf(key)];
  while (stack.length > 0) {
    const thread = stack.pop()!;
    descendants.push(thread);
    stack.push(...arrangement.childrenOf(arrangedThreadKey(thread)));
  }
  return descendants;
}

/** Threads `thread` may be moved under: same environment, not itself or one of its descendants. */
export function arrangeParentCandidates<T extends ArrangeableThread>(
  thread: T,
  threads: readonly T[],
  arrangement: ThreadArrangement<T>,
): T[] {
  const key = arrangedThreadKey(thread);
  const excluded = new Set([key, ...arrangedDescendants(key, arrangement).map(arrangedThreadKey)]);
  return threads.filter(
    (candidate) =>
      candidate.environmentId === thread.environmentId &&
      !excluded.has(arrangedThreadKey(candidate)),
  );
}
