export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function $(root: ParentNode, sel: string) {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el as HTMLElement;
}

export function input(root: ParentNode, sel: string) {
  return $(root, sel) as HTMLInputElement;
}
