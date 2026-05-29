// Tabs.js — an accessible tab controller (WAI-ARIA Tabs pattern).
//
// Wires any [role="tablist"] whose tabs reference panels via aria-controls.
// Supports mouse + keyboard: Left/Right/Up/Down move between tabs, Home/End jump
// to first/last, and the selected tab uses a roving tabindex. Purely presentational
// — the Renderer keeps rendering into every panel regardless of which is visible.

export function initTabs(root = document) {
  const tablist = root.querySelector('[role="tablist"]');
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  if (!tabs.length) return;

  function panelFor(tab) {
    const id = tab.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }

  function select(tab, focus) {
    for (const t of tabs) {
      const isSel = t === tab;
      t.setAttribute("aria-selected", isSel ? "true" : "false");
      t.tabIndex = isSel ? 0 : -1;
      const panel = panelFor(t);
      if (panel) panel.hidden = !isSel;
    }
    if (focus) tab.focus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next != null) {
        e.preventDefault();
        select(tabs[next], true);
      }
    });
  });
}
