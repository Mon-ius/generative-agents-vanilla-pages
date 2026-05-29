// MemoryPanel.js — renders the selected agent's memory stream (newest first).
// Each memory shows its type (icon + label, never colour-only), timestamp,
// importance, and description.

import { el, clear } from "../utils/dom.js";
import { CONFIG } from "../config.js";
import { TimeManager } from "../simulation/TimeManager.js";

const TYPE_ICON = {
  observation: "👁",
  action: "🚶",
  conversation: "💬",
  reflection: "💡",
  plan: "🗓",
  event: "📣",
};

export function renderMemory(container, sim) {
  clear(container);
  const agent = sim.getSelectedAgent();
  if (!agent) return;
  const all = agent.memoryStream.all();
  if (!all.length) {
    container.appendChild(el("li", { class: "muted", text: "No memories yet — step the simulation." }));
    return;
  }
  const recent = all.slice(-CONFIG.ui.memoryVisible).reverse();
  for (const m of recent) {
    const li = el("li", { class: `mem-item mem-item--${m.type}` }, [
      el("div", { class: "mem-head" }, [
        el("span", { class: `mem-type mem-type--${m.type}` }, `${TYPE_ICON[m.type] || "•"} ${m.type}`),
        el("span", { class: "mem-time muted", text: TimeManager.formatTotal(m.timestamp) }),
        el("span", { class: "mem-importance", title: `Importance ${m.importance} of 10`, "aria-label": `importance ${m.importance} of 10` }, `★ ${m.importance}`),
      ]),
      el("p", { class: "mem-desc", text: m.description }),
    ]);
    container.appendChild(li);
  }
}
