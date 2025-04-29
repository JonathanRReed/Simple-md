# Simple-md

I built Simple-md because I couldn’t find a simple Markdown editor & viewer that fit my needs.
This app includes support for math (LaTeX via MathJax) & Mermaid diagrams, so you can write & preview equations & graphs right in your notes.

**Main dependencies used:**

- Python 3
- PyQt6 (for the UI)
- PyQt6-WebEngine (for the HTML/JS preview)
- markdown2 (for Markdown to HTML conversion)
- MathJax (for math rendering, loaded in the preview)
- Mermaid.js (for diagrams, loaded in the preview)

**To run:**

1. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

2. Start the app:

   ```bash
   python src/main.py
   ```

This program was made by Jonathan Reed.  
A product of Hello.World Consulting.

**MIT License**.

Copyright (c) 2025 Jonathan Ray Reed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
