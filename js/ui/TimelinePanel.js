// TimelinePanel.js — renders the world event feed (newest first).
// Movements, observations, conversations, reflections, and world events all flow
// through here. Type is conveyed by an icon + label, not by colour alone.

import { el, clear } from "../utils/dom.js";
import { CONFIG } from "../config.js";

const TYPE_ICON = {
  movement: "🚶",
  conversation: "💬",
  reflection: "💡",
  event: "📣",
  observation: "👁",
};

export function renderTimeline(container, sim) {
  clear(container);
  if (!sim.timeline.length) {
    container.appendChild(el("li", { class: "muted", text: "Nothing has happened yet — press Start or Step." }));
    return;
  }
  const recent = sim.timeline.slice(-CONFIG.ui.timelineVisible).reverse();
  for (const e of recent) {
    const loc = e.locationId ? sim.environment.getLocation(e.locationId) : null;
    const li = el("li", { class: `tl-item tl-item--${e.type}` }, [
      el("div", { class: "tl-head" }, [
        el("span", { class: `tl-type tl-type--${e.type}` }, `${TYPE_ICON[e.type] || "•"} ${e.type}`),
        el("span", { class: "tl-time muted", text: e.timeLabel }),
      ]),
      el("div", { class: "tl-title", text: e.title }),
      el("p", { class: "tl-desc muted", text: e.description }),
      loc ? el("div", { class: "tl-loc muted", text: `@ ${loc.name}` }) : null,
    ]);
    container.appendChild(li);
  }
}
