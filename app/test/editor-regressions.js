await doc('editable MDX', 'note.MDX', 2, 'edit');
await until(() => document.querySelector('.cm-content'));
assert(!document.querySelector('#edit').hidden, 'MDX enters editing for edit intent');
await command('toggle-edit');
assert(document.querySelector('#edit').hidden, 'MDX switches to read view');
await command('toggle-edit');
assert(!document.querySelector('#edit').hidden, 'MDX returns to editing');

await doc('a text', 'a.md', 3, 'edit');
await until(() => document.querySelector('.cm-content'));
const content = document.querySelector('.cm-content');
content.focus();
document.execCommand('selectAll');
document.execCommand('insertText', false, 'updated a');
await wait(50);
await command('save');
assert(pending.length === 1, 'save submits current editor text');
await doc('b text', 'b.md', 4);
pending[0].resolve({documentId:3, text:pending[0].text, path:'/tmp/a.md',name:'a.md',baseUrl:'file:///tmp/'});
await wait(60);
assert(document.querySelector('#name').textContent === 'b.md', 'late save completion cannot rename another document');
assert(document.documentElement.dataset.documentPainted === '/tmp/b.md', 'paint marker names the current document');

const ui = await import('./ui.js');
let finds = 0;
window.find = () => {finds++;return true};
ui.openReadFind(() => {});
ui.openReadFind(() => {});
document.querySelector('#find-input').value = 'b';
document.querySelector('#find-input').dispatchEvent(new Event('input'));
assert(finds === 1, 'reopening find does not add search handlers');
document.querySelector('#find-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
ui.openReadFind(() => {});
document.querySelector('#find-input').dispatchEvent(new Event('input'));
assert(finds === 2, 'closing find removes input handlers');

ui.closeOverlays();
await doc('retained', 'retained.md', 5, 'read', [
 {key:'one',html:'<h1>Retained heading</h1>'},
 {key:'two',html:'<p>Retained text</p>'},
 {key:'three',html:'<p>Tail</p>'}
]);
const retained = [...document.querySelector('#doc').children];
const changes = [];
const observer = new MutationObserver(records => changes.push(...records));
observer.observe(document.querySelector('#doc'), {childList:true});
await doc('retained update', 'retained.md', 6, 'read', [
 {key:'one',html:'<h1>Retained heading</h1>'},
 {key:'two',html:'<p>Retained text</p>'},
 {key:'three',html:'<p>Tail</p>'}
]);
assert(retained.every((node,i) => document.querySelector('#doc').children[i] === node), 'unchanged read blocks retain their DOM identity');
assert(changes.length === 0, 'unchanged blocks produce zero child-list mutations');
observer.disconnect();

await doc('A', 'history-a.md', 7);
await doc('B', 'history-b.md', 8);
await command('nav-back');
await command('nav-back');
assert(calls.opened.at(-1) === '/tmp/history-a.md' && calls.opened.at(-2) === '/tmp/history-a.md', 'canceled navigation keeps the same back target');
let resolveOpen;
window.simplemd.openPath = p => {calls.opened.push(p);return new Promise(resolve => resolveOpen = resolve)};
listeners.command('nav-back');
await wait(20);
await doc('A', 'history-a.md', 9);
resolveOpen();
await wait(30);
listeners.command('nav-forward');
await wait(20);
assert(calls.opened.at(-1) === '/tmp/history-b.md', 'successful back navigation adds the forward target');
resolveOpen();

await doc('frozen', 'freeze.md', 10, 'edit');
listeners.transition(true);
await wait(20);
assert(document.querySelector('#edit').inert, 'transition makes editor pane inert');
assert(document.querySelector('.cm-content').contentEditable === 'false', 'transition disables CodeMirror edits');
await command('format-bold');
listeners.flush(1);
assert(flushed.text === 'frozen' && flushed.documentId === 10, 'frozen formatting cannot alter the flushed snapshot');
listeners.transition(false);
assert(document.querySelector('.cm-content').contentEditable === 'true', 'editor resumes after a canceled transition');
await command('save-as');
assert(pending.at(-1).id === 10, 'save carries document identity');
pending.at(-1).resolve(null);
await wait(20);

await doc('', 'Untitled', 11, 'edit');
listeners.doc({documentId:12,path:null,name:'Untitled',text:'',title:'Untitled',intent:'edit',baseUrl:null,blocks:[]});
await wait(100);
await command('save');
assert(pending.at(-1).id === 12 && pending.at(-1).dialog === false, 'ordinary Save submits an untitled note to the naming flow');
pending.at(-1).resolve(null);
await wait(20);
assert(calls.ready === 12, 'untitled document acknowledges readiness');

const {createEditor} = await import('./editor.js');
const host = document.createElement('div');
host.style.cssText='position:fixed;inset:80px 40px;background:white;z-index:100';
document.body.append(host);
const edited = [];
const ed = createEditor(host, {text:'original full text',mode:'source',host:{renderFragment:async x=>x,baseUrl:()=>null,openLink:()=>{}},onChange:text=>edited.push(text),onScroll:()=>{},onImages:async()=>null});
ed.focus();
document.execCommand('selectAll');
document.execCommand('insertText', false, 'replacement full text');
await wait(50);
assert(ed.getText() === 'replacement full text', 'select-all replaces the entire source');
ed.undo();
assert(ed.getText() === 'original full text', 'undo restores a full-text replacement');
ed.redo();
assert(ed.getText() === 'replacement full text', 'redo restores a full-text replacement');
ed.setText('external reload');
ed.undo();
assert(ed.getText() === 'external reload', 'disk reload cannot resurrect obsolete undo text');
ed.destroy();
host.remove();

const replaceText = async text => {
 const input = document.querySelector('#editor-host .cm-content');
 input.focus();
 document.execCommand('selectAll');
 document.execCommand('insertText', false, text);
 await wait(40);
};
await doc('save baseline', 'saving.md', 13, 'edit');
await replaceText('first saved revision');
await command('save');
const saving = pending.at(-1);
await replaceText('typed while saving');
saving.resolve({documentId:13,text:saving.text,path:'/tmp/saving.md',name:'saving.md',baseUrl:'file:///tmp/'});
await wait(60);
assert(!document.querySelector('#dirty').hidden && calls.dirty.at(-1)[0] === true, 'save acknowledgement preserves edits typed during saving');
await command('save');
assert(pending.at(-1).text === 'typed while saving', 'next save includes the newer text');
pending.at(-1).resolve({documentId:13,text:'typed while saving',path:'/tmp/saving.md',name:'saving.md',baseUrl:'file:///tmp/'});
await wait(40);

await window.simplemd.setSettings({autosave:true});
await replaceText('local conflict text');
listeners.disk('external conflict text', 13);
const conflictSaveCount = pending.length;
await wait(1050);
assert(pending.length === conflictSaveCount && !document.querySelector('#banner').hidden, 'external conflict blocks autosave until an explicit choice');
[...document.querySelectorAll('#banner button')].find(button => button.textContent === 'Keep mine').click();
await wait(1000);
assert(pending.length === conflictSaveCount + 1 && pending.at(-1).text === 'local conflict text', 'Keep mine authorizes saving the local conflict text');
pending.at(-1).resolve({documentId:13,text:'local conflict text',path:'/tmp/saving.md',name:'saving.md',baseUrl:'file:///tmp/'});
await wait(30);
await window.simplemd.setSettings({autosave:false});

const defaultRender = window.simplemd.renderBlocks;
let finishRead;
window.simplemd.renderBlocks = text => new Promise(resolve => finishRead = () => resolve({title:'obsolete title',blocks:blocks(text)}));
listeners.command('toggle-edit');
await wait(30);
await doc('current document', 'current.md', 14);
finishRead();
await wait(40);
assert(document.title === 'current.md' && document.querySelector('#doc').textContent === 'current document', 'obsolete read rendering cannot replace a newer document');
window.simplemd.renderBlocks = defaultRender;

await doc('image anchor', 'images.md', 15, 'edit');
let finishImage;
window.simplemd.saveImage = (bytes, ext, id) => {calls.images.push({ext,id});return new Promise(resolve => finishImage = resolve)};
const pasteImage = () => {
 const data = new DataTransfer();
 data.items.add(new File(['image'], 'example.png', {type:'image/png'}));
 document.querySelector('#editor-host .cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
};
document.querySelector('#editor-host .cm-content').focus();
document.execCommand('selectAll');
window.getSelection().collapseToEnd();
await wait(40);
pasteImage();
await until(() => finishImage);
await replaceText('moved anchor');
finishImage('assets/image (1)#.png');
await wait(80);
listeners.flush(1);
assert(flushed.text.includes('![](assets/image%20%281%29%23.png)'), 'pasted image paths escape Markdown delimiters and reserved filename characters');
assert(flushed.text.includes('moved anchor'), 'async image insertion preserves intervening text changes');
finishImage = null;
pasteImage();
await until(() => finishImage);
await doc('image destination stays clean', 'after-image.md', 16, 'edit');
finishImage('assets/late.png');
await wait(80);
listeners.flush(1);
assert(flushed.text === 'image destination stays clean', 'late image imports cannot insert into another document');
assert(calls.images.every(call => call.id === 15), 'image writes carry the originating document identity');

await window.simplemd.setSettings({mode:'source'});
await doc('source opens directly', 'source-only.md', 17, 'edit', [{key:'expensive',html:'<p>Should stay unmounted</p>'}]);
assert(document.querySelector('#doc').childElementCount === 0 && document.querySelector('#preview').childElementCount === 0, 'source intent avoids hidden read and preview block DOM');
await window.simplemd.setSettings({mode:'split'});
await wait(70);
assert(document.querySelector('#edit').dataset.mode === 'split' && !document.querySelector('#preview-pane').hidden, 'mode preference updates the active editor layout');
await window.simplemd.setSettings({mode:'source'});
await doc('retains source choice', 'next-source.md', 18, 'edit');
assert(document.querySelector('.cm-editor').dataset.mode === 'source', 'new documents retain the selected source mode');

await doc('initial preview', 'coalesced.md', 20, 'edit');
const renderRequests = [];
window.simplemd.renderBlocks = text => new Promise(resolve => renderRequests.push({text,resolve}));
await window.simplemd.setSettings({mode:'split'});
await until(() => renderRequests.length === 1);
for (let n=1;n<=4;n++) {
 await replaceText('revision '+n);
 await wait(130);
}
assert(renderRequests.length === 1, 'slow preview holds at most one render IPC in flight');
renderRequests[0].resolve({title:'obsolete',blocks:blocks('obsolete')});
await until(() => renderRequests.length === 2);
assert(renderRequests[1].text === 'revision 4', 'pending preview coalesces to the latest text snapshot');
renderRequests[1].resolve({title:'latest',blocks:blocks('revision 4')});
await wait(60);
assert(document.querySelector('#preview').textContent === 'revision 4', 'coalesced preview displays the latest revision');
window.simplemd.renderBlocks = async () => {throw new Error('worker stopped')};
await replaceText('recoverable render error');
await wait(180);
assert(document.querySelector('#toast').textContent === "Couldn't render this preview.", 'current render failures produce visible feedback');
window.simplemd.renderBlocks = defaultRender;
await window.simplemd.setSettings({mode:'source'});

let insertImage;
const imageHost = document.createElement('div');
document.body.append(imageHost);
const imageEd = createEditor(imageHost, {text:'abc',mode:'source',host:{renderFragment:async x=>x,baseUrl:()=>null,openLink:()=>{}},onChange:()=>{},onScroll:()=>{},onImages:()=>new Promise(resolve=>insertImage=resolve)});
imageEd.goTo(3);
const paste = new DataTransfer();
paste.items.add(new File(['image'],'image.png',{type:'image/png'}));
imageHost.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:paste,bubbles:true,cancelable:true}));
await until(()=>insertImage);
imageEd.goTo(0);
document.execCommand('insertText',false,'prefix ');
await wait(30);
insertImage('![image](image.png)');
await wait(50);
assert(imageEd.getText() === 'prefix abc![image](image.png)', 'pending image insertion follows edits before its original anchor');
imageEd.destroy();
imageHost.remove();

await doc('disk baseline', 'accept-race.md', 22, 'edit');
await replaceText('local text after acceptance');
let acceptDisk;
window.simplemd.acceptDisk = () => new Promise(resolve => acceptDisk = resolve);
listeners.disk('external disk version', 22);
[...document.querySelectorAll('#banner button')].find(button => button.textContent === 'Keep mine').click();
await until(() => acceptDisk);
assert(!document.querySelector('#banner').hidden && document.querySelector('#banner button').disabled, 'conflict banner remains pending until disk acceptance commits');
acceptDisk(true);
await until(() => document.querySelector('#banner').hidden);
await command('save');
assert(pending.at(-1).id === 22 && pending.at(-1).text === 'local text after acceptance', 'Save immediately after Keep mine completes submits the local text');
pending.at(-1).resolve({documentId:22,text:'local text after acceptance',path:'/tmp/accept-race.md',name:'accept-race.md',baseUrl:'file:///tmp/'});
await wait(30);

await doc('polished screenshot', 'Field notes.md', 21, 'read', [
 {key:'title',html:'<h1>Field notes</h1>'},
 {key:'intro',html:'<p>A small place to read, edit, and keep Markdown files.</p>'},
 {key:'heading',html:'<h2>Keep the useful parts</h2>'},
 {key:'body',html:'<p>Live keeps the page close to the source. Split puts them side by side. Source leaves room for the text.</p>'},
 {key:'list',html:'<ul><li>Files stay on your computer.</li><li>Changes keep their undo history.</li></ul>'},
 {key:'code',html:'<pre><code>const note = "Write something useful.";</code></pre>'}
]);
