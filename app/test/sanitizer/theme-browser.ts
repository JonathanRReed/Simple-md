export {};
Object.assign(globalThis, { CorpusBrowser: { runBatch(inputs: string[]) {
  return inputs.map(html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const css = parsed.querySelector('style')!.textContent!;
    const root = document.createElement('div');
    const style = document.createElement('style');
    root.append(style, ...parsed.querySelectorAll('img'));
    document.body.append(root);
    const displays = [];
    for (const theme of ['light', 'dark']) {
      style.textContent = css.replace(/@media\s*\(prefers-color-scheme:\s*dark\)/g, theme === 'dark' ? '@media all' : '@media not all');
      displays.push([...root.querySelectorAll('img')].map(img => getComputedStyle(img).display !== 'none'));
    }
    root.remove();
    return displays;
  });
} } });
