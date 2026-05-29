// dom.js — minimal DOM helpers used only by the UI layer.
//
// This is the only utility module that touches the browser DOM. The simulation
// core never imports it, which keeps the core runnable headless (e.g. in Node).

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v === false) continue;
    else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.appendChild(
      typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c
    );
  }
  return node;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) {
  if (node) while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function on(node, type, handler, opts) {
  node.addEventListener(type, handler, opts);
  return () => node.removeEventListener(type, handler, opts);
}
