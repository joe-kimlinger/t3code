import { createFileRoute } from "@tanstack/react-router";

import { AttentionPage } from "../components/attention/AttentionPage";

export const Route = createFileRoute("/_chat/attention")({
  component: AttentionPage,
});
