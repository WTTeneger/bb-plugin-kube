// bb-plugin-kube — frontend entry.
//
// One nav panel ("Kubernetes"): a badge on the sidebar entry, a sidebar
// toolbar (context, namespaces, search, sections, active port-forwards) that
// replaces the thread list while the panel is open, and section pages.
// The UI lives in src/ui; this file only registers it.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerKubeIcons } from "./icons";
import { KubeHeader, KubePage, useKubeBadge } from "./src/ui/page";
import { KubeRolloutBlock } from "./src/ui/rollout-block";
import { KubeSidebar } from "./src/ui/sidebar";
import { PANEL_PATH } from "./src/ui/shared";

export default definePluginApp((app) => {
  registerKubeIcons(app);
  app.slots.navPanel({
    id: "kubernetes",
    title: "Kubernetes",
    icon: "kube-Ship",
    path: PANEL_PATH,
    component: KubePage,
    headerContent: KubeHeader,
    experimental_sidebar: KubeSidebar,
    experimental_useBadge: useKubeBadge,
  });
  // ```kube-rollout blocks in agent messages become a live rollout card.
  app.slots.experimental_codeFenceRenderer({
    id: "kube-rollout",
    languages: ["kube-rollout", "kube-status"],
    component: KubeRolloutBlock,
  });
});
