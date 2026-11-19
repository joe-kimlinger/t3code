import { useAtomValue } from "@effect/atom-react";
import {
  arrangeParentCandidates,
  arrangeThreads,
  arrangedThreadKey,
} from "@t3tools/client-runtime/state/thread-arrangement";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage, type ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadMoveUnderKeyAtom } from "../../state/thread-order";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { useThreadListActions } from "../home/useThreadListActions";

export function ThreadMoveUnderHost() {
  const threadKey = useAtomValue(threadMoveUnderKeyAtom);
  return threadKey === null ? null : (
    <ThreadMoveUnderSheet
      threadKey={threadKey}
      onClose={() => appAtomRegistry.set(threadMoveUnderKeyAtom, null)}
    />
  );
}

/** Picks the thread to nest a thread under, or the top level. */
function ThreadMoveUnderSheet(props: { threadKey: string; onClose: () => void }) {
  const gt = useGT();
  const shells = useAtomValue(steadyNavigationThreadShellsAtom);
  const { arrangeThread } = useThreadListActions();
  const listed = shells.filter(
    (thread) => thread.archivedAt === null && isListedThreadLineage(thread.lineage),
  );
  const arrangement = arrangeThreads(listed);
  const thread = listed.find((candidate) => arrangedThreadKey(candidate) === props.threadKey);
  const currentParentKey = arrangement.parentKeyOf(props.threadKey);
  const candidates =
    thread === undefined
      ? []
      : arrangeParentCandidates(thread, listed, arrangement)
          .filter((candidate) => arrangedThreadKey(candidate) !== currentParentKey)
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const move = (parent: EnvironmentThreadShell | null) => {
    if (thread === undefined) return;
    props.onClose();
    void arrangeThread(thread, (parent?.id ?? null) satisfies ThreadId | null);
  };
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaProvider style={{ flex: 1 }}>
        <View className="flex-1 bg-screen">
          <SafeAreaView style={{ flex: 1 }}>
            <SheetHeader
              presentation="inline"
              title={gt("Move under…", { $context: "nest this thread under another" })}
              onClose={props.onClose}
            />
            <ScrollView contentContainerClassName="pb-8">
              {currentParentKey !== null ? (
                <MoveUnderRow
                  icon="arrow.turn.left.up"
                  title={gt("Move to top level")}
                  onPress={() => move(null)}
                />
              ) : null}
              {candidates.map((candidate) => (
                <MoveUnderRow
                  key={arrangedThreadKey(candidate)}
                  icon="text.bubble"
                  title={candidate.title}
                  onPress={() => move(candidate)}
                />
              ))}
            </ScrollView>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function MoveUnderRow(props: {
  icon: "arrow.turn.left.up" | "text.bubble";
  title: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle px-5 py-3 active:bg-subtle"
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-foreground-muted" />
      <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
    </Pressable>
  );
}
