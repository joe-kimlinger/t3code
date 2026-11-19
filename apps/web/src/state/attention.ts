import { createAttentionEnvironmentAtoms } from "@t3tools/client-runtime/state/attention";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";

export const attentionEnvironment = createAttentionEnvironmentAtoms(connectionAtomRuntime);

/** Every connected environment's attention stream, keyed by `environmentIdsKey`. */
export const attentionLiveListAtom = environmentAtomList("web-attention-live", (environmentId) =>
  attentionEnvironment.live({ environmentId, input: {} }),
);
