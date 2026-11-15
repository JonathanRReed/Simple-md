/** The metadata title belongs in print, where the metadata disclosure is hidden. */
export function addPrintTitle(article: HTMLElement, doc: { title: string; text: string }): void {
  if (!/^\uFEFF?---(?:\r\n|[\r\n])/.test(doc.text) || article.querySelector("h1")) return;
  // A valid metadata title is already resolved by the shared renderer.
  const metadata = article.querySelector("details.frontmatter");
  if (!metadata) return;
  const titleRow = [...metadata.querySelectorAll(":scope > .frontmatter-body > table > tbody > tr")].find(row => row.querySelector("th, td")?.textContent?.trim() === "title");
  const value = titleRow?.querySelector("td");
  if (!value || value.firstElementChild || value.textContent?.trim() !== doc.title) return;
  const heading = document.createElement("h1");
  heading.textContent = doc.title;
  article.prepend(heading);
}
