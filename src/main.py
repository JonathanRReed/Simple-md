import sys
import os
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
        # Softer OLED/neon palette
        self.heading = QColor('#3ad7ff')
        self.bold = QColor('#a08cff')
        self.italic = QColor('#b6eaff')
        self.code = QColor('#8afff7')
        self.blockquote = QColor('#8c8cff')
        self.listitem = QColor('#7fffd4')
        self.link = QColor('#6ecbff')
        self.image = QColor('#8cffa0')
        self.strikethrough = QColor('#b0b0b0')
        self.hr = QColor('#444')
        self.footnote = QColor('#ffb86b')
        self.taskbox = QColor('#b6eaff')
        self.highlight = QColor('#fff799')
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
        import re
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
        self.setWindowIcon(QIcon('resources/icon.png'))
        self.resize(1000, 700)
        self._load_custom_fonts()
        self._setup_ui()
        self._setup_menu()
        self._setup_syntax_popup()

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
        # --- Frosted Glass and Softer Neon Styling ---
        toolbar.setStyleSheet('''
            QToolBar {
                background: rgba(0,0,0,0.85); /* frosted glass effect */
                border-bottom: 1px solid #3ad7ff;
            }
            QToolButton {
                color: #b6eaff;
                background: transparent;
                font-weight: bold;
                padding: 6px 16px;
                border-radius: 4px;
            }
            QToolButton:focus {
                outline: 2px solid #a08cff;
                background: rgba(40,40,60,0.7);
            }
            QToolButton:hover {
                background: rgba(30,30,50,0.7);
                color: #a08cff;
            }
        ''')
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
        export_md_action = QAction("Markdown (.md)", self)
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
                background: rgba(0,0,0,0.9);
                color: #b6eaff;
                border: 2px solid #3ad7ff;
                font-size: 14px;
                border-radius: 6px;
            }
            QListWidget::item:selected {
                background: rgba(60,60,90,0.8);
                color: #a08cff;
            }
            QListWidget::item:hover {
                background: rgba(30,30,50,0.7);
                color: #a08cff;
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
                background: rgba(0,0,0,0.92);
                border: 2px solid #3ad7ff;
                border-radius: 10px;
            }
            QLineEdit {
                background: rgba(20,20,30,0.92);
                color: #b6eaff;
                border: 2px solid #3ad7ff;
                padding: 6px;
                font-size: 16px;
                border-radius: 6px;
            }
            QListWidget {
                background: rgba(0,0,0,0.93);
                color: #b6eaff;
                border: none;
                font-size: 15px;
            }
            QListWidget::item:selected {
                background: rgba(60,60,90,0.8);
                color: #a08cff;
            }
            QLabel {
                color: #a08cff;
                font-size: 13px;
                padding: 2px 0 4px 0;
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

    def update_preview(self):
        md_text = self.editor.toPlainText()
        # Preprocess: convert mermaid code blocks to <div class="mermaid">...</div>
        import re
        def mermaid_replacer(match):
            code = match.group(1)
            return f'<div class="mermaid">{code}</div>'
        md_text_mermaid = re.sub(r'```mermaid\n([\s\S]*?)```', mermaid_replacer, md_text)
        # Render Markdown to HTML
        html = self.markdown(md_text_mermaid)
        # Inject MathJax and Mermaid.js scripts
        html_head = '''
        <head>
        <meta charset="utf-8">
        <style>
            body { background: #000; color: #b6eaff; font-family: sans-serif; }
            code, pre { font-family: sans-serif; }
            .mermaid { background: #111; border-radius: 8px; margin: 1em 0; padding: 1em; }
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
        html_full = f'<!DOCTYPE html><html>{html_head}<body>{html}</body></html>'
        self.preview.setHtml(html_full)

    def new_file(self):
        self.editor.clear()
        self.current_file = None

    def open_file(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "Open Markdown File", str(BASE_DIR), "Markdown Files (*.md)")
        if file_path:
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    self.editor.setPlainText(f.read())
                self.current_file = file_path
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to open file:\n{e}")

    def save_file(self):
        if self.current_file:
            try:
                with open(self.current_file, 'w', encoding='utf-8') as f:
                    f.write(self.editor.toPlainText())
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to save file:\n{e}")
        else:
            self.save_file_as()

    def save_file_as(self):
        file_path, _ = QFileDialog.getSaveFileName(self, "Save Markdown File", str(BASE_DIR), "Markdown Files (*.md)")
        if file_path:
            try:
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(self.editor.toPlainText())
                self.current_file = file_path
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to save file:\n{e}")

    def export_markdown(self):
        file_path, _ = QFileDialog.getSaveFileName(self, "Export as Markdown", str(BASE_DIR), "Markdown Files (*.md)")
        if file_path:
            try:
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(self.editor.toPlainText())
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to export Markdown:\n{e}")

    def export_html(self):
        file_path, _ = QFileDialog.getSaveFileName(self, "Export as HTML", str(BASE_DIR), "HTML Files (*.html)")
        if file_path:
            try:
                html = self.markdown(self.editor.toPlainText())
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
                html = self.markdown(self.editor.toPlainText())
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
                background: rgba(0,0,0,0.92);
                border: 2px solid #3ad7ff;
                border-radius: 10px;
            }
            QLineEdit {
                background: rgba(20,20,30,0.92);
                color: #b6eaff;
                border: 2px solid #3ad7ff;
                padding: 6px;
                font-size: 16px;
                border-radius: 6px;
            }
            QListWidget {
                background: rgba(0,0,0,0.93);
                color: #b6eaff;
                border: none;
                font-size: 15px;
            }
            QListWidget::item:selected {
                background: rgba(60,60,90,0.8);
                color: #a08cff;
            }
            QListWidget::item:hover {
                background: rgba(30,30,50,0.7);
                color: #a08cff;
            }
            QLabel {
                color: #a08cff;
                font-size: 13px;
                padding: 2px 0 4px 0;
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
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #181828, stop:1 #10101a);
                border: 2px solid #3ad7ff;
                border-radius: 18px;
            }
            QLabel, QTextEdit {
                color: #b6eaff;
                font-size: 15px;
            }
            QTextEdit {
                background: #10101a;
                border: 1px solid #3ad7ff;
                border-radius: 8px;
                padding: 8px;
                margin-bottom: 12px;
            }
            QPushButton {
                background: #181828;
                color: #a08cff;
                border: 1px solid #3ad7ff;
                border-radius: 5px;
                padding: 6px 18px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: #222244;
                color: #fff799;
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
        layout.addSpacing(12)
        prod_label = QLabel('<span style="color:#b6eaff;font-size:18px;font-weight:bold;background:transparent;">A product of <span style="color:#a08cff;font-weight:bold;">Hello.World Consulting</span></span>')
        prod_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        prod_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
        layout.addWidget(prod_label)
        author_label = QLabel('<span style="color:#d1b1ff;font-style:italic;font-size:16px;background:transparent;">Made by Jonathan Reed</span>')
        author_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        author_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
        layout.addWidget(author_label)
        link_label = QLabel('<a href="https://helloworldfirm.com" style="color:#3af7ff;font-size:18px;font-weight:bold;background:transparent;">helloworldfirm.com</a>')
        link_label.setOpenExternalLinks(True)
        link_label.setTextInteractionFlags(link_label.textInteractionFlags() | Qt.TextInteractionFlag.TextSelectableByMouse)
        link_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        link_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
        layout.addWidget(link_label)
        copyright_label = QLabel('<span style="color:#888;font-size:14px;background:transparent;">2025 &copy; All Rights Reserved</span>')
        copyright_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        copyright_label.setStyleSheet("background: transparent; margin-bottom: 4px;")
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
    if qss_path.exists():
        with open(qss_path, "r") as f:
            app.setStyleSheet(f.read())
    window = MarkdownEditor()
    window.show()
    sys.exit(app.exec())
