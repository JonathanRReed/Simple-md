export {};
function runBatch(inputs: string[]) {
  return inputs.map((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body;
    const hazards: string[] = [];
    if (body.querySelector("script, style, iframe, template, noscript, object, embed")) hazards.push("active element");
    for (const node of body.querySelectorAll("*")) for (const { name, value } of node.attributes) {
      if (/^on/i.test(name)) hazards.push("event handler");
      if (/^(?:href|src|srcset)$/.test(name) && /javascript:|vbscript:/i.test(value)) hazards.push("script URL");
      if (/^(?:src|srcset)$/.test(name) && /https?:|\/\//i.test(value.replace(/^file:\/\//, ""))) hazards.push("remote resource");
    }
    const css = doc.querySelector("style")!.textContent!;
    return { csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
      generated: { shiki: body.querySelectorAll(".shiki").length, math: body.querySelectorAll(".katex").length,
        checkbox: body.querySelectorAll('input[type="checkbox"][disabled]').length, alerts: body.querySelectorAll(".markdown-alert").length,
        footnotes: body.querySelectorAll(".footnotes").length, fake: body.querySelectorAll("[data-evil], [onclick], pre.mermaid").length,
        copyButtons: body.querySelectorAll("button.copy-code").length }, hazards,
      local: body.querySelector('img[alt="local"]')?.getAttribute("src"), mermaid: body.querySelector("code.language-mermaid")?.textContent,
      fonts: [...css.matchAll(/url\(data:font\/woff2;base64,/g)].length };
  });
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });
