// SPDX-License-Identifier: Apache-2.0
// Tiny, safe Markdown subset for the privacy notice: "# " and "## " headings,
// "- " list items and paragraphs. Builds DOM nodes with textContent only.

export function parseMarkdown(text) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      flushPara();
      flushList();
    } else if (/^#{1,3} /.test(line)) {
      flushPara();
      flushList();
      const level = line.indexOf(" ");
      blocks.push({ type: level === 1 ? "h3" : "h4", text: line.slice(level + 1) });
    } else if (line.startsWith("- ")) {
      flushPara();
      if (!list) list = [];
      list.push(line.slice(2));
    } else if (list) {
      list[list.length - 1] += ` ${line}`;
    } else {
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

export function renderMarkdown(text, doc = document) {
  const frag = doc.createDocumentFragment();
  for (const block of parseMarkdown(text)) {
    if (block.type === "ul") {
      const ul = doc.createElement("ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        li.textContent = item;
        ul.append(li);
      }
      frag.append(ul);
    } else {
      const el = doc.createElement(block.type);
      el.textContent = block.text;
      frag.append(el);
    }
  }
  return frag;
}
