/**
 * 使用示例
 *
 * <div class="editor-scroller" id="scroller"></div>
 */

import { ChunkedEditor, type OutlineItem } from './chunk/chunked-editor';
import './chunk/style.css';

const scroller = document.getElementById('scroller') as HTMLElement;

const markdown = await fetch('/api/doc/123').then((r) => r.text());

const outline: OutlineItem[] = [];

const editor = new ChunkedEditor({
  scroller,
  content: markdown,
  splitLevel: 2,          // 按 H1/H2 切
  overscan: 1,            // 视口外多挂 1 屏
  onOutline(items) {
    outline.length = 0;
    outline.push(...items);
    renderOutline();
  },
  onSave(md) {
    // 防抖已在内部做过,这里直接落盘或推给上层
    console.log('saved, length =', md.length);
  },
});

await editor.mount();

function renderOutline() {
  const box = document.getElementById('outline');
  if (!box) return;
  box.innerHTML = '';
  for (const item of outline) {
    const btn = document.createElement('button');
    btn.className = 'doc-outline-item';
    btn.dataset.level = String(item.level);
    btn.textContent = item.title;
    btn.onclick = () => editor.scrollToChunk(item.id);
    box.appendChild(btn);
  }
}

// 全文导出(会自动 flush 所有已挂载实例)
console.log(editor.getMarkdown());

// 组件卸载时
// editor.destroy();