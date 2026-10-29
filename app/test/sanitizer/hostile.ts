export function hostileInputs(count: number): string[] {
  let state = 0x51a71c;
  const next = (size: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % size; };
  const opens = ["<div>", "<p>", "<b>", "<a>", "<table>", "<tr><td>", "<select><option>", "<svg>", "<svg><foreignObject>", "<math><mtext>", "<math><annotation-xml encoding='text/html'>", "<template>", "<noscript>", "<form>", "<picture>", "<details><summary>X</summary>"];
  const closes = ["</div>", "</p>", "</b>", "</a>", "</table>", "</td></tr>", "</select>", "</svg>", "</foreignObject></svg>", "</mtext></math>", "</annotation-xml></math>", "</template>", "</noscript>", "</form>", "</picture>", "</details>"];
  const payloads = [
    '<img src=x onerror="alert(1)">', '<a href="jav&#x61;script:alert(1)" id="x">X</a>',
    '<img src="java&#9;script:x" SRC="https://safe.test/a">', '<p STYLE="display:none" CLASS=mermaid data-x=1>X</p>',
    '<script>alert(1)</script><style>body{display:none}</style>', '<iframe srcdoc="<img onerror=alert(1)>">X</iframe>',
    '<source srcset="data:image/svg+xml,%3Csvg%3E 1x, a,b.svg 2x, javascript:x 3x">',
    '<a name=doc id=location href="#location">A</a><p id=location>B</p>',
    '<!--><img src=x onerror=alert(1)>-->', '<![CDATA[<img src=x onerror=alert(1)>]]>',
    '<?xml version="1.0"?><b>Safe</b>', '<!--[CDATA[--><img src=x onerror=alert(1)>',
    '<x-widget><b>Safe</b></x-widget><div is=x-widget>X</div>', '<img title="--><img src=x onerror=alert(1)>">',
    '<a href="https://safe.test/" title="&quot; onload=alert(1)">X</a>', '<p id=" x " headers="x y" title="</style>">X</p>',
    '<h1 id="x">Title</h1><h1>Title</h1>', '<IMG/SRC=javascript:alert(1) ONERROR=alert(1)>',
    '<textarea>&lt;img onerror=alert(1)&gt;</textarea>', '<video controls muted autoplay src="clip.mp4"></video>',
  ];
  return Array.from({ length: count }, () => {
    const depth = 1 + next(5);
    const nesting = Array.from({ length: depth }, () => next(opens.length));
    let html = nesting.map((i) => opens[i]).join("") + payloads[next(payloads.length)]!;
    for (let i = 0; i < 1 + next(4); i++) html += payloads[next(payloads.length)]!;
    if (next(3)) html += nesting.reverse().map((i) => closes[i]).join("");
    if (next(4) === 0) html = html.slice(0, next(html.length));
    return html;
  });
}

