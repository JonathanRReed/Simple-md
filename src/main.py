import sys
import os
import re
from pathlib import Path
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QSplitter, QTextEdit, QFileDialog, QMessageBox, QMenuBar, QListWidget,
    QToolBar, QToolButton, QMenu, QDialog, QVBoxLayout, QLineEdit, QListWidgetItem, QLabel, QPushButton, QHBoxLayout
)
from PyQt6.QtGui import QAction, QTextCursor, QKeyEvent, QFontDatabase, QFont, QSyntaxHighlighter, QTextCharFormat, QColor, QIcon
from PyQt6.QtCore import Qt, QUrl
from PyQt6.QtWebEngineWidgets import QWebEngineView
import markdown2

# Paths for resources
BASE_DIR = Path(__file__).resolve().parent.parent
RESOURCES_DIR = BASE_DIR / 'resources'
FONTS_DIR = RESOURCES_DIR / 'TTF'
ICONS_DIR = RESOURCES_DIR / 'icons'

class MarkdownHighlighter(QSyntaxHighlighter):
    def __init__(self, parent=None):
        super().__init__(parent)
        # Premium refined palette - softer, more readable colors
        self.heading = QColor('#7aa2f7')      # Soft blue
        self.bold = QColor('#bb9af7')         # Soft purple
        self.italic = QColor('#9ece6a')       # Soft green
        self.code = QColor('#7dcfff')         # Cyan
        self.blockquote = QColor('#9aa5ce')   # Muted blue-gray
        self.listitem = QColor('#73daca')     # Teal
        self.link = QColor('#7aa2f7')         # Soft blue
        self.image = QColor('#9ece6a')        # Soft green
        self.strikethrough = QColor('#565f89')  # Muted gray
        self.hr = QColor('#3b4261')           # Dark separator
        self.footnote = QColor('#e0af68')     # Warm amber
        self.taskbox = QColor('#7dcfff')      # Cyan
        self.highlight = QColor('#e0af68')    # Warm amber
        self.rules = []
        # Headings
        fmt = QTextCharFormat(); fmt.setForeground(self.heading); fmt.setFontWeight(QFont.Weight.Bold)
        self.rules.append((r'^(#{1,6})\s.*', fmt))
        # Bold
        fmt = QTextCharFormat(); fmt.setForeground(self.bold); fmt.setFontWeight(QFont.Weight.Bold)
        self.rules.append((r'\*\*[^\*]+\*\*', fmt))
        self.rules.append((r'__[^_]+__', fmt))
        # Italic
        fmt = QTextCharFormat(); fmt.setForeground(self.italic); fmt.setFontItalic(True)
        self.rules.append((r'\*[^\*]+\*', fmt))
        self.rules.append((r'_[^_]+_', fmt))
        # Inline code
        fmt = QTextCharFormat(); fmt.setForeground(self.code); fmt.setFontFamily('monospace')
        self.rules.append((r'`[^`]+`', fmt))
        # Blockquote
        fmt = QTextCharFormat(); fmt.setForeground(self.blockquote)
        self.rules.append((r'^>.*', fmt))
        # List items
        fmt = QTextCharFormat(); fmt.setForeground(self.listitem)
        self.rules.append((r'^(\s*[-+*]|\s*\d+\.)\s', fmt))
        # Link
        fmt = QTextCharFormat(); fmt.setForeground(self.link); fmt.setFontUnderline(True)
        self.rules.append((r'\[[^\]]+\]\([^\)]+\)', fmt))
        # Image
        fmt = QTextCharFormat(); fmt.setForeground(self.image)
        self.rules.append((r'!\[[^\]]*\]\([^\)]+\)', fmt))
        # Strikethrough
        fmt = QTextCharFormat(); fmt.setForeground(self.strikethrough); fmt.setFontStrikeOut(True)
        self.rules.append((r'~~[^~]+~~', fmt))
        # Horizontal rule
        fmt = QTextCharFormat(); fmt.setForeground(self.hr)
        self.rules.append((r'^---+$', fmt))
        # Footnote
        fmt = QTextCharFormat(); fmt.setForeground(self.footnote)
        self.rules.append((r'\[\^.+\]:.*', fmt))
        # Task list
        fmt = QTextCharFormat(); fmt.setForeground(self.taskbox)
        self.rules.append((r'- \[[ xX]\] ', fmt))
        # Highlight
        fmt = QTextCharFormat(); fmt.setForeground(self.highlight)
        self.rules.append((r'==[^=]+==', fmt))

    def highlightBlock(self, text):
        for pattern, fmt in self.rules:
            for match in re.finditer(pattern, text):
                start, end = match.start(), match.end()
                self.setFormat(start, end - start, fmt)

class AutoPairTextEdit(QTextEdit):
    pairs = {
        '(': ')',
        '[': ']',
        '{': '}',
        '"': '"',
        "'": "'",
        '`': '`',
    }

    def keyPressEvent(self, event):
        key = event.text()
        cursor = self.textCursor()
        doc = self.document()
        # --- Special: Auto-insert ```mermaid code block at line start ---
        if key == '`':
            block = cursor.block()
            block_text = block.text()[:cursor.positionInBlock()]
            if block_text.strip() == '':
                # At start of line, insert mermaid block
                selected = cursor.selectedText()
                mermaid_block = '```mermaid\n' + (selected if selected else '') + '\n```'
                cursor.insertText(mermaid_block)
                if not selected:
                    # Move cursor to empty line
                    cursor.movePosition(cursor.MoveOperation.Up)
                    cursor.movePosition(cursor.MoveOperation.EndOfLine)
                    self.setTextCursor(cursor)
                return
        # --- Special: Auto-pair $$ for math blocks ---
        if key == '$':
            prev_char = self.toPlainText()[cursor.position()-1:cursor.position()]
            if prev_char == '$':
                # Remove the just-inserted $ (so only one pair is inserted)
                cursor.deletePreviousChar()
                selected = cursor.selectedText()
                if selected:
                    cursor.insertText('$$' + selected + '$$')
                    cursor.setPosition(cursor.position() - len(selected) - 2)
                    self.setTextCursor(cursor)
                else:
                    cursor.insertText('$$  $$')
                    cursor.movePosition(cursor.MoveOperation.Left)
                    cursor.movePosition(cursor.MoveOperation.Left)
                    self.setTextCursor(cursor)
                return
        # --- Standard pairs ---
        if key in self.pairs:
            closing = self.pairs[key]
            if cursor.hasSelection():
                selected = cursor.selectedText()
                cursor.insertText(key + selected + closing)
                cursor.setPosition(cursor.position() - len(selected) - 1)
                self.setTextCursor(cursor)
                return
            else:
                after = self.toPlainText()[cursor.position():cursor.position()+1]
                if after != closing:
                    cursor.insertText(key + closing)
                    cursor.movePosition(cursor.MoveOperation.Left)
                    self.setTextCursor(cursor)
                    return
        super().keyPressEvent(event)

class MarkdownEditor(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Simple-md")
        self.setWindowIcon(QIcon(str(RESOURCES_DIR / 'icon2.png')))
        self.resize(1000, 700)
        self.current_file = None
        # Debounce timer to prevent preview flickering
        from PyQt6.QtCore import QTimer
        self._preview_timer = QTimer()
        self._preview_timer.setSingleShot(True)
        self._preview_timer.setInterval(150)  # 150ms debounce
        self._preview_timer.timeout.connect(self._do_update_preview)
        self._load_custom_fonts()
        self._setup_ui()
        self._setup_menu()
        self._setup_syntax_popup()
        self.setAcceptDrops(True)  # Enable drag-and-drop

    def _load_custom_fonts(self):
        # Load all TTF fonts from resources/TTF
        font_dir = FONTS_DIR
        if font_dir.exists():
            for font_file in font_dir.glob('*.ttf'):
                QFontDatabase.addApplicationFont(str(font_file))

    def _setup_ui(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.editor = AutoPairTextEdit()
        # Use system default font for editor
        font = QFont()
        font.setPointSize(13)
        self.editor.setFont(font)
        self.preview = QWebEngineView()
        self.editor.textChanged.connect(self.update_preview)
        self.editor.textChanged.connect(self._update_status_bar)
        self.editor.installEventFilter(self)
        # Attach Markdown syntax highlighter
        self.highlighter = MarkdownHighlighter(self.editor.document())
        splitter.addWidget(self.editor)
        splitter.addWidget(self.preview)
        splitter.setSizes([600, 400])
        self.setCentralWidget(splitter)
        # Use markdown2 for robust Markdown support
        self.markdown = markdown2.markdown

        # Add a text-only toolbar for core actions
        toolbar = self.addToolBar('Main Toolbar')
        toolbar.setMovable(False)
        toolbar.setFloatable(False)
        # Add text-only actions to toolbar
        toolbar.addAction('New', self.new_file)
        toolbar.addAction('Open', self.open_file)
        toolbar.addAction('Save', self.save_file)
        toolbar.addAction('Export', self.export_menu)
        toolbar.addSeparator()
        toolbar.addAction('Undo', self.editor.undo)
        toolbar.addAction('Redo', self.editor.redo)
        toolbar.addSeparator()
        toolbar.addAction('MD Palette', self.show_markdown_palette)
        toolbar.addAction('Palette', self.show_command_palette)
        # Add Info button
        info_action = QAction('Info', self)
        info_action.triggered.connect(self.show_info_dialog)
        toolbar.addAction(info_action)

        # Add status bar with document info
        from PyQt6.QtWidgets import QStatusBar
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.setStyleSheet('''
            QStatusBar {
                background: #0d0f14;
                color: #6b7280;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
                padding: 4px 12px;
                font-size: 12px;
            }
            QStatusBar::item {
                border: none;
            }
        ''')
        self.word_count_label = QLabel("0 words")
        self.char_count_label = QLabel("0 chars")
        self.file_label = QLabel("Untitled")
        self.status_bar.addWidget(self.file_label)
        self.status_bar.addPermanentWidget(self.word_count_label)
        self.status_bar.addPermanentWidget(QLabel("  |  "))
        self.status_bar.addPermanentWidget(self.char_count_label)

        self._do_update_preview()  # Initial render (bypass debounce)

    def _update_status_bar(self):
        """Update status bar with word and character count."""
        text = self.editor.toPlainText()
        words = len(text.split()) if text.strip() else 0
        chars = len(text)
        self.word_count_label.setText(f"{words:,} words")
        self.char_count_label.setText(f"{chars:,} chars")
        if self.current_file:
            self.file_label.setText(Path(self.current_file).name)
        else:
            self.file_label.setText("Untitled")

    def _setup_menu(self):
        menu_bar = QMenuBar(self)
        file_menu = menu_bar.addMenu("&File")

        new_action = QAction("New", self)
        new_action.triggered.connect(self.new_file)
        file_menu.addAction(new_action)

        open_action = QAction("Open...", self)
        open_action.triggered.connect(self.open_file)
        file_menu.addAction(open_action)

        save_action = QAction("Save", self)
        save_action.triggered.connect(self.save_file)
        file_menu.addAction(save_action)

        save_as_action = QAction("Save As...", self)
        save_as_action.triggered.connect(self.save_file_as)
        file_menu.addAction(save_as_action)

        export_menu = file_menu.addMenu("Export As")
        export_md_action = QAction("Markdown / MDX (.md/.mdx)", self)
        export_md_action.triggered.connect(self.export_markdown)
        export_menu.addAction(export_md_action)
        export_html_action = QAction("HTML (.html)", self)
        export_html_action.triggered.connect(self.export_html)
        export_menu.addAction(export_html_action)
        export_pdf_action = QAction("PDF (.pdf)", self)
        export_pdf_action.triggered.connect(self.export_pdf)
        export_menu.addAction(export_pdf_action)

        self.setMenuBar(menu_bar)
        self.current_file = None

    def _setup_syntax_popup(self):
        # Syntax, WikiLink, and Tag suggestions
        self.syntax_items = [
            ("Heading 1", "# "),
            ("Heading 2", "## "),
            ("Heading 3", "### "),
            ("Heading 4", "#### "),
            ("Heading 5", "##### "),
            ("Heading 6", "###### "),
            ("Bold", "**bold text**"),
            ("Italic", "*italic text*"),
            ("Link", "[text](url)"),
            ("Image", "![alt text](image-url)"),
            ("Unordered List", "* item"),
            ("Ordered List", "1. item"),
            ("Code Block", "```\ncode\n```"),
            ("Blockquote", "> quote")
        ]
        self.wikilink_items = [
            ("Home", "[[Home]]"),
            ("About", "[[About]]"),
            ("Reference", "[[Reference]]"),
        ]
        self.tag_items = [
            ("todo", "#todo"),
            ("important", "#important"),
            ("idea", "#idea"),
        ]
        self.syntax_popup = QListWidget(self)
        self.syntax_popup.setWindowFlags(Qt.WindowType.Popup)
        self.syntax_popup.hide()
        self.syntax_popup.setStyleSheet('''
            QListWidget {
                background: rgba(18, 21, 28, 0.96);
                color: #e4e8f1;
                border: 1px solid rgba(255, 255, 255, 0.1);
                font-size: 14px;
                border-radius: 12px;
                padding: 6px;
            }
            QListWidget::item {
                padding: 8px 12px;
                border-radius: 8px;
                margin: 2px;
            }
            QListWidget::item:selected {
                background: rgba(108, 140, 255, 0.18);
                color: #ffffff;
            }
            QListWidget::item:hover:!selected {
                background: rgba(255, 255, 255, 0.06);
            }
        ''')
        self.syntax_popup.itemClicked.connect(self.insert_selected_syntax)
        self._popup_trigger = None
        self._popup_filter = ""

    def show_syntax_popup(self, trigger="/", filter_text=""):
        # Choose items based on trigger
        if trigger == "/":
            items = self.syntax_items
        elif trigger == "[[":
            items = self.wikilink_items
        elif trigger == "#":
            items = self.tag_items
        else:
            items = []
        # Filter items
        filtered = [item for item in items if filter_text.lower() in item[0].lower()]
        self.syntax_popup.clear()
        for item in filtered:
            self.syntax_popup.addItem(item[0])
        if filtered:
            self.syntax_popup.setCurrentRow(0)
        self.syntax_popup.move(self.editor.mapToGlobal(self.editor.cursorRect().bottomLeft()))
        self.syntax_popup.show()
        self.syntax_popup.setFocus()
        self._popup_trigger = trigger
        self._popup_filter = filter_text
        self._popup_filtered = filtered

    def handle_editor_keypress(self, event: QKeyEvent):
        cursor = self.editor.textCursor()
        if self.syntax_popup.isVisible():
            if event.key() == Qt.Key.Key_Down:
                self.syntax_popup.setCurrentRow((self.syntax_popup.currentRow() + 1) % self.syntax_popup.count())
                return True
            elif event.key() == Qt.Key.Key_Up:
                self.syntax_popup.setCurrentRow((self.syntax_popup.currentRow() - 1) % self.syntax_popup.count())
                return True
            elif event.key() in (Qt.Key.Key_Enter, Qt.Key.Key_Return):
                self.insert_selected_syntax()
                return True
            elif event.key() == Qt.Key.Key_Escape:
                self.syntax_popup.hide()
                return True
            elif event.text():
                # Update filter
                self._popup_filter += event.text()
                self.show_syntax_popup(self._popup_trigger, self._popup_filter)
                return True
            elif event.key() == Qt.Key.Key_Backspace and self._popup_filter:
                self._popup_filter = self._popup_filter[:-1]
                self.show_syntax_popup(self._popup_trigger, self._popup_filter)
                return True
        # Trigger popup on '/' or '[[' at start of line or after whitespace (NO # trigger)
        if event.text() == '/':
            block = cursor.block().text()
            pos = cursor.positionInBlock()
            if block[:pos].strip() == '':
                self.show_syntax_popup("/")
                return False
        elif event.text() == '[':
            block = cursor.block().text()
            pos = cursor.positionInBlock()
            if pos >= 2 and block[pos-2:pos] == '[[':
                self.show_syntax_popup("[[")
                return False
        return False

    def insert_selected_syntax(self):
        row = self.syntax_popup.currentRow()
        if row < 0 or not hasattr(self, '_popup_filtered'):
            self.syntax_popup.hide()
            return
        syntax = self._popup_filtered[row][1]
        cursor = self.editor.textCursor()
        # Remove trigger and filter text before inserting
        length = len(self._popup_trigger) + len(self._popup_filter)
        cursor.movePosition(QTextCursor.MoveOperation.Left, QTextCursor.MoveMode.KeepAnchor, length)
        if cursor.selectedText().startswith(self._popup_trigger):
            cursor.removeSelectedText()
        cursor.insertText(syntax)
        self.editor.setTextCursor(cursor)
        self.syntax_popup.hide()

    # --- Command Palette ---
    def show_command_palette(self):
        from PyQt6.QtWidgets import QDialog, QVBoxLayout, QLineEdit, QListWidget, QListWidgetItem
        dialog = QDialog(self)
        dialog.setModal(True)
        dialog.setWindowTitle("Command Palette")
        dialog.setStyleSheet('''
            QDialog {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                    stop:0 rgba(18, 21, 28, 0.98),
                    stop:1 rgba(13, 15, 20, 0.98));
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 16px;
            }
            QLineEdit {
                background: rgba(255, 255, 255, 0.05);
                color: #e4e8f1;
                border: 1px solid rgba(255, 255, 255, 0.1);
                padding: 12px 16px;
                font-size: 15px;
                border-radius: 12px;
                margin-bottom: 8px;
            }
            QLineEdit:focus {
                border: 1px solid rgba(108, 140, 255, 0.45);
                background: rgba(255, 255, 255, 0.07);
            }
            QLineEdit::placeholder {
                color: #6b7280;
            }
            QListWidget {
                background: transparent;
                color: #e4e8f1;
                border: none;
                font-size: 14px;
                outline: none;
            }
            QListWidget::item {
                padding: 10px 14px;
                border-radius: 8px;
                margin: 2px 0;
            }
            QListWidget::item:selected {
                background: rgba(108, 140, 255, 0.18);
                color: #ffffff;
            }
            QListWidget::item:hover:!selected {
                background: rgba(255, 255, 255, 0.05);
            }
            QLabel {
                color: #8892a8;
                font-size: 12px;
                padding: 4px 0;
            }
        ''')
        layout = QVBoxLayout()
        search_box = QLineEdit()
        search_box.setPlaceholderText("Type a command...")
        command_list = QListWidget()
        commands = [
            ("New File", self.new_file),
            ("Open File", self.open_file),
            ("Save File", self.save_file),
            ("Export Markdown", self.export_markdown),
            ("Export HTML", self.export_html),
            ("Export PDF", self.export_pdf),
            ("Undo", self.editor.undo),
            ("Redo", self.editor.redo),
            ("Cut", self.editor.cut),
            ("Paste", self.editor.paste)
        ]
        for cmd, _ in commands:
            command_list.addItem(cmd)
        command_list.setCurrentRow(0)
        layout.addWidget(search_box)
        layout.addWidget(command_list)
        dialog.setLayout(layout)
        # --- Filtering ---
        def filter_commands():
            text = search_box.text().lower()
            command_list.clear()
            for cmd, _ in commands:
                if text in cmd.lower():
                    command_list.addItem(cmd)
            if command_list.count() > 0:
                command_list.setCurrentRow(0)
        search_box.textChanged.connect(filter_commands)
        # --- Keyboard navigation ---
        def handle_palette_key(event):
            if event.key() == Qt.Key.Key_Down:
                row = command_list.currentRow()
                if row < command_list.count() - 1:
                    command_list.setCurrentRow(row + 1)
            elif event.key() == Qt.Key.Key_Up:
                row = command_list.currentRow()
                if row > 0:
                    command_list.setCurrentRow(row - 1)
            elif event.key() in (Qt.Key.Key_Enter, Qt.Key.Key_Return):
                row = command_list.currentRow()
                if row >= 0:
                    cmd_text = command_list.item(row).text()
                    for cmd, fn in commands:
                        if cmd == cmd_text:
                            dialog.accept()
                            fn()
                            break
            elif event.key() == Qt.Key.Key_Escape:
                dialog.reject()
        search_box.keyPressEvent = lambda event: (handle_palette_key(event) if handle_palette_key(event) is not None else QLineEdit.keyPressEvent(search_box, event))
        command_list.keyPressEvent = lambda event: handle_palette_key(event)
        dialog.resize(380, 320)
        search_box.setFocus()
        dialog.exec()

    def eventFilter(self, obj, event):
        if obj == self.editor and event.type() == event.Type.KeyPress:
            return self.handle_editor_keypress(event)
        return super().eventFilter(obj, event)

    def _looks_like_mdx(self, text: str) -> bool:
        if self.current_file and str(self.current_file).lower().endswith('.mdx'):
            return True
        if re.search(r'^\s*(import|export)\s', text, flags=re.MULTILINE):
            return True
        if re.search(r'^\s*<\s*[A-Z][A-Za-z0-9_.-]*\b', text, flags=re.MULTILINE):
            return True
        return False

    def _mdx_to_markdown(self, text: str):
        if not self._looks_like_mdx(text):
            return text, False

        original = text

        out_lines = []
        in_component = None
        in_fence = False
        for line in text.splitlines():
            if re.match(r'^\s*```', line):
                in_fence = not in_fence
                out_lines.append(line)
                continue

            if not in_fence:
                if re.match(r'^\s*(import|export)\s', line):
                    continue
                line = re.sub(r'\{/\*([\s\S]*?)\*/\}', r'<!--\1-->', line)

            if in_component is not None:
                out_lines.append(line)
                if re.search(rf'^\s*</\s*{re.escape(in_component)}\s*>\s*$', line):
                    out_lines.append('```')
                    in_component = None
                continue

            if not in_fence:
                m = re.match(r'^\s*<\s*([A-Z][A-Za-z0-9_.-]*)\b', line)
                if m:
                    tag = m.group(1)
                    out_lines.append('```jsx')
                    out_lines.append(line)
                    if re.search(r'/\s*>\s*$', line) or re.search(rf'</\s*{re.escape(tag)}\s*>\s*$', line):
                        out_lines.append('```')
                    else:
                        in_component = tag
                    continue

            out_lines.append(line)

        if in_component is not None:
            out_lines.append('```')

        rendered = '\n'.join(out_lines)
        return rendered, rendered != original

    def _coerce_save_extension(self, file_path: str, selected_filter: str) -> str:
        p = Path(file_path)
        if p.suffix:
            return file_path

        selected = (selected_filter or '').lower()
        if '.mdx' in selected:
            return str(p.with_suffix('.mdx'))
        return str(p.with_suffix('.md'))

    def update_preview(self):
        """Debounced preview update - waits for typing to pause before rendering."""
        self._preview_timer.start()

    def _do_update_preview(self):
        """Actually render the preview (called after debounce delay)."""
        md_text = self.editor.toPlainText()
        md_text, mdx_changed = self._mdx_to_markdown(md_text)
        # Preprocess: convert mermaid code blocks to <div class="mermaid">...</div>
        def mermaid_replacer(match):
            code = match.group(1)
            return f'<div class="mermaid">{code}</div>'
        md_text_mermaid = re.sub(r'```mermaid\n([\s\S]*?)```', mermaid_replacer, md_text)
        # Render Markdown to HTML
        if md_text_mermaid.strip():
            html = self.markdown(md_text_mermaid)
        else:
            html = (
                '<section class="welcome">'
                '<div class="welcome-header">'
                '<h1>Simple-md</h1>'
                '<p class="tagline">A premium Markdown & MDX viewer</p>'
                '</div>'
                '<p class="lead">Start typing on the left to see a live preview here.</p>'
                '<div class="cards">'
                '<div class="card">'
                '<div class="card-icon">&#9998;</div>'
                '<div class="card-content">'
                '<div class="title">Markdown</div>'
                '<div class="body">Headings, lists, links, tables, code blocks, and more.</div>'
                '</div>'
                '</div>'
                '<div class="card">'
                '<div class="card-icon">&#8747;</div>'
                '<div class="card-content">'
                '<div class="title">Math</div>'
                '<div class="body">Inline <code>$E=mc^2$</code> and block <code>$$...$$</code> equations.</div>'
                '</div>'
                '</div>'
                '<div class="card">'
                '<div class="card-icon">&#9670;</div>'
                '<div class="card-content">'
                '<div class="title">Mermaid</div>'
                '<div class="body">Use <code>```mermaid</code> fences to render diagrams.</div>'
                '</div>'
                '</div>'
                '</div>'
                '<div class="keyboard-hints">'
                '<span class="hint"><kbd>/</kbd> Syntax popup</span>'
                '<span class="hint"><kbd>[[</kbd> WikiLinks</span>'
                '<span class="hint"><kbd>$$</kbd> Math blocks</span>'
                '</div>'
                '</section>'
            )
        mdx_note = ''
        if self._looks_like_mdx(self.editor.toPlainText()) and mdx_changed:
            mdx_note = '<div class="note"><span class="note-icon">&#9432;</span> MDX preview: component blocks are shown as <code>jsx</code> code.</div>'
        # Premium HTML styling with refined theme
        html_head = '''
        <head>
        <meta charset="utf-8">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg-deep: #0d0f14;
                --bg-primary: #12151c;
                --bg-elevated: #1a1e28;
                --bg-glass: rgba(26, 30, 40, 0.75);
                --text-primary: #e4e8f1;
                --text-secondary: #a0a8b8;
                --text-muted: #6b7280;
                --accent-blue: #7aa2f7;
                --accent-purple: #bb9af7;
                --accent-teal: #73daca;
                --accent-amber: #e0af68;
                --border-subtle: rgba(255, 255, 255, 0.06);
                --border-medium: rgba(255, 255, 255, 0.1);
                --code-bg: rgba(255, 255, 255, 0.05);
                --shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            }
            
            * { box-sizing: border-box; }
            
            html {
                background: var(--bg-deep);
                scrollbar-width: thin;
                scrollbar-color: rgba(255,255,255,0.12) transparent;
            }
            
            ::-webkit-scrollbar { width: 8px; height: 8px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { 
                background: rgba(255,255,255,0.12); 
                border-radius: 4px;
            }
            ::-webkit-scrollbar-thumb:hover { background: rgba(122, 162, 247, 0.35); }
            
            body {
                margin: 0;
                padding: 32px 24px 48px 24px;
                background: linear-gradient(180deg, var(--bg-deep) 0%, var(--bg-primary) 100%);
                color: var(--text-primary);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 15px;
                line-height: 1.7;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
                min-height: 100vh;
            }
            
            .doc {
                max-width: 820px;
                margin: 0 auto;
                background: var(--bg-glass);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid var(--border-subtle);
                border-radius: 20px;
                padding: 32px 36px;
                box-shadow: var(--shadow);
            }
            
            /* === Typography === */
            h1, h2, h3, h4, h5, h6 {
                color: var(--text-primary);
                font-weight: 600;
                letter-spacing: -0.02em;
                margin: 1.5em 0 0.6em 0;
                line-height: 1.3;
            }
            h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
            h1 { font-size: 2.2em; font-weight: 700; }
            h2 { font-size: 1.65em; }
            h3 { font-size: 1.35em; }
            h4 { font-size: 1.15em; }
            
            p { margin: 0.9em 0; color: var(--text-secondary); }
            
            a { 
                color: var(--accent-blue); 
                text-decoration: none;
                transition: color 0.2s ease;
            }
            a:hover { 
                color: var(--accent-purple);
                text-decoration: underline; 
            }
            
            strong { color: var(--text-primary); font-weight: 600; }
            em { font-style: italic; }
            
            /* === Lists === */
            ul, ol { 
                margin: 1em 0; 
                padding-left: 1.5em;
                color: var(--text-secondary);
            }
            li { margin: 0.4em 0; }
            li::marker { color: var(--accent-teal); }
            
            /* === Horizontal Rule === */
            hr { 
                border: none; 
                height: 1px;
                background: linear-gradient(90deg, transparent, var(--border-medium), transparent);
                margin: 2em 0; 
            }
            
            /* === Blockquote === */
            blockquote {
                margin: 1.5em 0;
                padding: 1em 1.25em;
                background: rgba(122, 162, 247, 0.06);
                border-left: 3px solid var(--accent-blue);
                border-radius: 0 12px 12px 0;
                color: var(--text-secondary);
                font-style: italic;
            }
            blockquote p { margin: 0.5em 0; }
            blockquote p:first-child { margin-top: 0; }
            blockquote p:last-child { margin-bottom: 0; }
            
            /* === Code === */
            code {
                font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
                font-size: 0.9em;
                background: var(--code-bg);
                padding: 0.2em 0.5em;
                border-radius: 6px;
                color: var(--accent-teal);
            }
            
            pre {
                background: var(--code-bg);
                border: 1px solid var(--border-subtle);
                border-radius: 12px;
                padding: 18px 20px;
                overflow-x: auto;
                margin: 1.5em 0;
            }
            pre code {
                background: none;
                padding: 0;
                font-size: 0.88em;
                line-height: 1.6;
                color: var(--text-secondary);
            }
            
            /* === Tables === */
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 1.5em 0;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid var(--border-subtle);
                border-radius: 12px;
                overflow: hidden;
            }
            th, td { 
                padding: 12px 16px; 
                text-align: left;
                border-bottom: 1px solid var(--border-subtle); 
            }
            th { 
                background: rgba(255, 255, 255, 0.04); 
                color: var(--text-primary);
                font-weight: 600;
                font-size: 0.9em;
                text-transform: uppercase;
                letter-spacing: 0.03em;
            }
            tr:last-child td { border-bottom: none; }
            tr:hover td { background: rgba(255, 255, 255, 0.02); }
            
            /* === Images === */
            img { 
                max-width: 100%; 
                border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            }
            
            /* === Mermaid Diagrams === */
            .mermaid { 
                background: rgba(255, 255, 255, 0.03); 
                border: 1px solid var(--border-subtle); 
                border-radius: 16px; 
                margin: 1.5em 0; 
                padding: 1.5em;
                text-align: center;
            }
            
            /* === Notes/Alerts === */
            .note {
                display: flex;
                align-items: center;
                gap: 10px;
                background: rgba(187, 154, 247, 0.08);
                border: 1px solid rgba(187, 154, 247, 0.25);
                color: var(--text-secondary);
                padding: 12px 16px;
                border-radius: 12px;
                margin: 0 0 20px 0;
                font-size: 0.92em;
            }
            .note-icon {
                color: var(--accent-purple);
                font-size: 1.1em;
            }
            
            /* === Welcome Screen === */
            .welcome {
                text-align: center;
                padding: 20px 0;
            }
            .welcome-header {
                margin-bottom: 8px;
            }
            .welcome h1 {
                font-size: 2.8em;
                margin: 0;
                background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }
            .welcome .tagline {
                color: var(--text-muted);
                font-size: 1em;
                margin: 8px 0 0 0;
                font-weight: 400;
            }
            .welcome .lead {
                font-size: 1.1em;
                color: var(--text-secondary);
                margin: 24px 0 32px 0;
            }
            
            .cards {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 16px;
                text-align: left;
            }
            .card {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid var(--border-subtle);
                border-radius: 16px;
                padding: 20px;
                transition: all 0.25s ease;
            }
            .card:hover {
                background: rgba(255, 255, 255, 0.05);
                border-color: var(--border-medium);
                transform: translateY(-2px);
            }
            .card-icon {
                font-size: 1.5em;
                margin-bottom: 12px;
                color: var(--accent-blue);
            }
            .card .title {
                font-weight: 600;
                color: var(--text-primary);
                margin-bottom: 8px;
                font-size: 1.05em;
            }
            .card .body {
                color: var(--text-muted);
                font-size: 0.9em;
                line-height: 1.5;
            }
            
            .keyboard-hints {
                display: flex;
                justify-content: center;
                gap: 24px;
                margin-top: 32px;
                flex-wrap: wrap;
            }
            .hint {
                color: var(--text-muted);
                font-size: 0.85em;
            }
            kbd {
                display: inline-block;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid var(--border-medium);
                border-radius: 6px;
                padding: 3px 8px;
                font-family: inherit;
                font-size: 0.9em;
                margin-right: 6px;
                color: var(--text-secondary);
            }
            
            @media (max-width: 700px) {
                .cards { grid-template-columns: 1fr; }
                .doc { padding: 24px 20px; }
                body { padding: 20px 16px 32px 16px; }
            }
        </style>
        <!-- MathJax -->
        <script type="text/javascript" id="MathJax-script" async
            src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
        <!-- Mermaid.js -->
        <script type="module">
        import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
        window.addEventListener('DOMContentLoaded', () => { mermaid.initialize({ startOnLoad: true, theme: 'dark' }); });
        </script>
        </head>
        '''
        html_full = f'<!DOCTYPE html><html>{html_head}<body><main class="doc">{mdx_note}{html}</main></body></html>'
        self.preview.setHtml(html_full)

    def new_file(self):
        self.editor.clear()
        self.current_file = None
        self._update_status_bar()
        self._update_window_title()

    def _load_file(self, file_path):
        """Load a markdown/mdx file into the editor."""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                self.editor.setPlainText(f.read())
            self.current_file = file_path
            self._update_status_bar()
            self._update_window_title()
            return True
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to open file:\n{e}")
            return False

    def _update_window_title(self):
        """Update window title with current file name."""
        if self.current_file:
            self.setWindowTitle(f"Simple-md - {Path(self.current_file).name}")
        else:
            self.setWindowTitle("Simple-md")

    def dragEnterEvent(self, event):
        """Accept drag events for markdown/mdx files."""
        if event.mimeData().hasUrls():
            for url in event.mimeData().urls():
                if url.isLocalFile():
                    path = url.toLocalFile().lower()
                    if path.endswith('.md') or path.endswith('.mdx'):
                        event.acceptProposedAction()
                        return
        event.ignore()

    def dropEvent(self, event):
        """Handle dropped markdown/mdx files."""
        for url in event.mimeData().urls():
            if url.isLocalFile():
                file_path = url.toLocalFile()
                if file_path.lower().endswith(('.md', '.mdx')):
                    self._load_file(file_path)
                    break

    def open_file(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Open Markdown/MDX File",
            str(Path.home()),  # Start from home directory
            "Markdown / MDX Files (*.md *.mdx);;Markdown Files (*.md);;MDX Files (*.mdx);;All Files (*)"
        )
        if file_path:
            self._load_file(file_path)

    def save_file(self):
        if self.current_file:
            try:
                with open(self.current_file, 'w', encoding='utf-8') as f:
                    f.write(self.editor.toPlainText())
                self.status_bar.showMessage("Saved!", 2000)  # Show for 2 seconds
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to save file:\n{e}")
        else:
            self.save_file_as()

    def save_file_as(self):
        # Start from current file's directory or home
        start_dir = str(Path(self.current_file).parent) if self.current_file else str(Path.home())
        file_path, selected_filter = QFileDialog.getSaveFileName(
            self,
            "Save Markdown/MDX File",
            start_dir,
            "Markdown Files (*.md);;MDX Files (*.mdx);;All Files (*)"
        )
        if file_path:
            try:
                file_path = self._coerce_save_extension(file_path, selected_filter)
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(self.editor.toPlainText())
                self.current_file = file_path
                self._update_status_bar()
                self._update_window_title()
                self.status_bar.showMessage("Saved!", 2000)
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to save file:\n{e}")

    def export_markdown(self):
        file_path, selected_filter = QFileDialog.getSaveFileName(
            self,
            "Export as Markdown/MDX",
            str(BASE_DIR),
            "Markdown Files (*.md);;MDX Files (*.mdx);;All Files (*)"
        )
        if file_path:
            try:
                file_path = self._coerce_save_extension(file_path, selected_filter)
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(self.editor.toPlainText())
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to export Markdown:\n{e}")

    def export_html(self):
        file_path, _ = QFileDialog.getSaveFileName(self, "Export as HTML", str(BASE_DIR), "HTML Files (*.html)")
        if file_path:
            try:
                md_text, _ = self._mdx_to_markdown(self.editor.toPlainText())
                html = self.markdown(md_text)
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(html)
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to export HTML:\n{e}")

    def export_pdf(self):
        file_path, _ = QFileDialog.getSaveFileName(self, "Export as PDF", str(BASE_DIR), "PDF Files (*.pdf)")
        if file_path:
            try:
                # QTextDocument for HTML to PDF
                from PyQt6.QtGui import QTextDocument
                doc = QTextDocument()
                md_text, _ = self._mdx_to_markdown(self.editor.toPlainText())
                html = self.markdown(md_text)
                doc.setHtml(html)
                printer = None
                try:
                    from PyQt6.QtPrintSupport import QPrinter
                    printer = QPrinter()
                    printer.setOutputFormat(QPrinter.OutputFormat.PdfFormat)
                    printer.setOutputFileName(file_path)
                    doc.print(printer)
                except ImportError:
                    QMessageBox.critical(self, "Error", "PyQt6.QtPrintSupport is required for PDF export.")
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to export PDF:\n{e}")

    def export_menu(self):
        # Show export options (Markdown, HTML, PDF) as a popup menu
        menu = QMenu(self)
        menu.addAction('Export as Markdown', self.export_markdown)
        menu.addAction('Export as HTML', self.export_html)
        menu.addAction('Export as PDF', self.export_pdf)
        menu.exec(self.mapToGlobal(self.cursor().pos()))

    # --- Markdown Palette ---
    def show_markdown_palette(self):
        from PyQt6.QtWidgets import QDialog, QVBoxLayout, QLineEdit, QListWidget, QLabel
        dialog = QDialog(self)
        dialog.setModal(True)
        dialog.setWindowTitle("Markdown Palette")
        dialog.setStyleSheet('''
            QDialog {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                    stop:0 rgba(18, 21, 28, 0.98),
                    stop:1 rgba(13, 15, 20, 0.98));
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 16px;
            }
            QLineEdit {
                background: rgba(255, 255, 255, 0.05);
                color: #e4e8f1;
                border: 1px solid rgba(255, 255, 255, 0.1);
                padding: 12px 16px;
                font-size: 15px;
                border-radius: 12px;
                margin-bottom: 8px;
            }
            QLineEdit:focus {
                border: 1px solid rgba(108, 140, 255, 0.45);
                background: rgba(255, 255, 255, 0.07);
            }
            QLineEdit::placeholder {
                color: #6b7280;
            }
            QListWidget {
                background: transparent;
                color: #e4e8f1;
                border: none;
                font-size: 14px;
                outline: none;
            }
            QListWidget::item {
                padding: 10px 14px;
                border-radius: 8px;
                margin: 2px 0;
            }
            QListWidget::item:selected {
                background: rgba(108, 140, 255, 0.18);
                color: #ffffff;
            }
            QListWidget::item:hover:!selected {
                background: rgba(255, 255, 255, 0.05);
            }
            QLabel {
                color: #8892a8;
                font-size: 12px;
                padding: 4px 0;
            }
        ''')
        layout = QVBoxLayout()
        search_box = QLineEdit()
        search_box.setPlaceholderText("Type to search Markdown elements...")
        md_list = QListWidget()
        # Markdown elements: (Display, Syntax)
        md_elements = [
            ("Heading 1", "# H1"),
            ("Heading 2", "## H2"),
            ("Heading 3", "### H3"),
            ("Bold", "**bold text**"),
            ("Italic", "*italicized text*"),
            ("Blockquote", "> blockquote"),
            ("Ordered List", "1. First item\n2. Second item\n3. Third item"),
            ("Unordered List", "- First item\n- Second item\n- Third item"),
            ("Inline Code", "`code`"),
            ("Horizontal Rule", "---"),
            ("Link", "[title](https://www.example.com)"),
            ("Image", "![alt text](image.jpg)"),
            ("Table", "| Syntax | Description |\n| ----------- | ----------- |\n| Header | Title |\n| Paragraph | Text |"),
            ("Fenced Code Block", "```\ncode\n```"),
            ("Footnote", "Here's a sentence with a footnote. [^1]\n\n[^1]: This is the footnote."),
            ("Heading ID", "### My Great Heading {#custom-id}"),
            ("Definition List", "term\n: definition"),
            ("Strikethrough", "~~The world is flat.~~"),
            ("Task List", "- [x] Write the press release\n- [ ] Update the website\n- [ ] Contact the media"),
            ("Emoji", "That is so funny! :joy:"),
            ("Highlight", "I need to highlight these ==very important words==."),
            ("Subscript", "H~2~O"),
            ("Superscript", "X^2^"),
        ]
        for label, _ in md_elements:
            md_list.addItem(label)
        md_list.setCurrentRow(0)
        layout.addWidget(search_box)
        layout.addWidget(md_list)
        desc_label = QLabel("Select a Markdown element to insert.")
        layout.addWidget(desc_label)
        dialog.setLayout(layout)
        # --- Filtering ---
        def filter_md():
            text = search_box.text().lower()
            md_list.clear()
            for label, _ in md_elements:
                if text in label.lower():
                    md_list.addItem(label)
            if md_list.count() > 0:
                md_list.setCurrentRow(0)
        search_box.textChanged.connect(filter_md)
        # --- Keyboard navigation and insert ---
        def handle_md_key(event):
            if event.key() == Qt.Key.Key_Down:
                row = md_list.currentRow()
                if row < md_list.count() - 1:
                    md_list.setCurrentRow(row + 1)
            elif event.key() == Qt.Key.Key_Up:
                row = md_list.currentRow()
                if row > 0:
                    md_list.setCurrentRow(row - 1)
            elif event.key() in (Qt.Key.Key_Enter, Qt.Key.Key_Return):
                row = md_list.currentRow()
                if row >= 0:
                    label = md_list.item(row).text()
                    for l, syntax in md_elements:
                        if l == label:
                            dialog.accept()
                            cursor = self.editor.textCursor()
                            cursor.insertText(syntax)
                            self.editor.setTextCursor(cursor)
                            break
            elif event.key() == Qt.Key.Key_Escape:
                dialog.reject()
        search_box.keyPressEvent = lambda event: (handle_md_key(event) if handle_md_key(event) is not None else QLineEdit.keyPressEvent(search_box, event))
        md_list.keyPressEvent = lambda event: handle_md_key(event)
        dialog.resize(420, 380)
        search_box.setFocus()
        dialog.exec()

    def show_info_dialog(self):
        from PyQt6.QtWidgets import QDialog, QVBoxLayout, QLabel, QTextEdit, QPushButton, QHBoxLayout
        from PyQt6.QtGui import QPixmap
        import os
        dialog = QDialog(self)
        dialog.setWindowTitle("Simple-md: Info & Tips")
        dialog.setModal(True)
        dialog.setStyleSheet('''
            QDialog {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                    stop:0 rgba(18, 21, 28, 0.99),
                    stop:1 rgba(13, 15, 20, 0.99));
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 20px;
            }
            QLabel {
                color: #e4e8f1;
                font-size: 14px;
                background: transparent;
            }
            QTextEdit {
                background: rgba(255, 255, 255, 0.04);
                color: #a0a8b8;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 12px;
                font-size: 13px;
                line-height: 1.5;
            }
            QPushButton {
                background: rgba(108, 140, 255, 0.12);
                color: #e4e8f1;
                border: 1px solid rgba(108, 140, 255, 0.25);
                border-radius: 10px;
                padding: 10px 24px;
                font-weight: 600;
                font-size: 14px;
            }
            QPushButton:hover {
                background: rgba(108, 140, 255, 0.2);
                border: 1px solid rgba(108, 140, 255, 0.4);
                color: #ffffff;
            }
            QPushButton:pressed {
                background: rgba(108, 140, 255, 0.28);
            }
        ''')
        layout = QVBoxLayout()
        label = QLabel("Welcome to Simple-md! Quick Guide:")
        layout.addWidget(label)
        info_text = QTextEdit()
        info_text.setReadOnly(True)
        info_text.setPlainText(
            """
Editor Pane (left):
- Type Markdown here. Syntax highlighting, auto-pairing, and keyboard shortcuts are supported.

Preview Pane (right):
- Shows a live preview of your Markdown, including diagrams and math.

---

Mermaid Diagrams:
To render a diagram, use:

```mermaid
graph TD
  A --> B
```

---

MathJax/LaTeX:
- Inline math: $E=mc^2$
- Block math:
  $$
  x = {-b \pm \sqrt{b^2-4ac} \over 2a}
  $$

---

Tips:
- Use the Palette for commands, MD Palette for Markdown snippets.
- Auto-pairing for (), [], {}, '', "", and ``.
- Export to HTML, PDF, and more.
- Syntax highlighting, smart indent, and more.
"""
        )
        layout.addWidget(info_text)
        # --- Custom Card Footer (Text Only) ---
        layout.addSpacing(16)
        prod_label = QLabel('<span style="color:#e4e8f1;font-size:16px;font-weight:600;background:transparent;">A product of <span style="color:#7aa2f7;font-weight:600;">Hello.World Consulting</span></span>')
        prod_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        prod_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
        layout.addWidget(prod_label)
        author_label = QLabel('<span style="color:#a0a8b8;font-style:italic;font-size:14px;background:transparent;">Made by Jonathan Reed</span>')
        author_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        author_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
        layout.addWidget(author_label)
        link_label = QLabel('<a href="https://helloworldfirm.com" style="color:#7aa2f7;font-size:14px;font-weight:500;background:transparent;">helloworldfirm.com</a>')
        link_label.setOpenExternalLinks(True)
        link_label.setTextInteractionFlags(link_label.textInteractionFlags() | Qt.TextInteractionFlag.TextSelectableByMouse)
        link_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        link_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
        layout.addWidget(link_label)
        copyright_label = QLabel('<span style="color:#6b7280;font-size:12px;background:transparent;">2025 &copy; All Rights Reserved</span>')
        copyright_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        copyright_label.setStyleSheet("background: transparent; margin-bottom: 8px;")
        layout.addWidget(copyright_label)
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(dialog.accept)
        layout.addWidget(close_btn)
        dialog.setLayout(layout)
        dialog.resize(540, 540)
        dialog.exec()

if __name__ == "__main__":
    app = QApplication(sys.argv)
    # Apply QSS theme
    qss_path = RESOURCES_DIR / "style.qss"
    if not qss_path.exists():
        qss_path = BASE_DIR / "style.qss"
    if qss_path.exists():
        with open(qss_path, "r") as f:
            app.setStyleSheet(f.read())
    window = MarkdownEditor()
    window.show()
    sys.exit(app.exec())
