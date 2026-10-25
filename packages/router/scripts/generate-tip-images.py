#!/usr/bin/env python3
"""Render privacy-safe UI tutorials from reviewed resources and native card code.

This development-only renderer never contacts Feishu or model providers. Every
screen is redrawn as SVG; supplied screenshots and real account data are not inputs.
Pillow and system librsvg/Cairo are required in addition to installed dev packages.
"""

import ctypes
import ctypes.util
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
from xml.etree import ElementTree
import zipfile

from PIL import Image, ImageFont

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'packages/router/src/tips'
DOCS = ROOT / 'docs/tips'
W, H = 1600, 1120
BLUE = '#245bdb'
FONT_PATH = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
BOLD_PATH = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
FONTS = {}
UI = json.loads((SOURCE / 'ui.zh-CN.json').read_text())['artwork']


def font(size, bold=False):
    key = size, bold
    if key not in FONTS:
        FONTS[key] = ImageFont.truetype(BOLD_PATH if bold else FONT_PATH, size)
    return FONTS[key]


def measure(value, size, bold=False):
    return font(size, bold).getlength(value)


def plain(value):
    return re.sub(r'\\([\\`*_{}\[\]()#+\-.!<>|])', r'\1', value.replace('**', '').replace('`', ''))


def settings_fixtures():
    # Exercise the real card builder with synthetic, public demo values only.
    script = r"""
import mod from './packages/router/src/feishu/SettingsCards.ts';
const {SettingsCards}=mod;
const backends=[['claude','Claude Code'],['codex','Codex CLI (OpenAI)'],
 ['opencode','OpenCode CLI'],['kimi','Kimi Code CLI'],['zcode','ZCode'],['pi','Pi'],
 ['agy','AGY CLI (Antigravity)'],['dsh','DeepSeek Harness (DSH)']]
 .map(([value,label])=>({value,label,installed:!['pi','dsh'].includes(value)}));
const base={threadId:'demo',threadName:'demo',coordinatorBackend:'claude',backends,
 effectiveSource:'configured',supportsReset:true,busy:false,expiresAt:Date.now()+60000};
const menus={
 model:{...base,kind:'model',snapshotId:'demo-model',targetBackend:'codex',
  configuredValue:'gpt-5.2-codex',effectiveValue:'gpt-5.2-codex',defaultValue:'gpt-5.2-codex',
  choices:[{value:'gpt-5.2-codex',label:'gpt-5.2-codex'}]},
 effort:{...base,kind:'effort',snapshotId:'demo-effort',coordinatorBackend:'codex',targetBackend:'codex',
  configuredValue:'high',effectiveValue:'high',defaultValue:'medium',
  choices:['low','medium','high'].map(value=>({value,label:value}))},
 backend:{...base,kind:'backend',snapshotId:'demo-backend',targetBackend:'claude',
  choices:[],supportsReset:false,followsGlobal:false}
};
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='behaviors').map(([key,item])=>[key,clean(item)])):value;
const result={};
for(const [key,menu] of Object.entries(menus)){
 const cards=new SettingsCards({ownsDevice:async()=>true,available:()=>true,
  send:async()=>true,update:async()=>{}});
 const prepared=cards.present({openId:'demo-owner',deviceId:'demo-device',menu,requestMessageId:'demo-request'});
 if(!prepared) throw Error('Synthetic menu rejected');
 result[key]=clean({schema:'2.0',header:cards['header']({menu}),body:{elements:prepared.elements}});
 prepared.discard();cards.destroy();
}
process.stdout.write(JSON.stringify(result));
"""
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module'],
                            input=script, text=True, cwd=ROOT, capture_output=True, check=True)
    return json.loads(result.stdout)


class Canvas:
    def __init__(self, tip, number):
        self.tip, self.number = tip, number
        self.parts, self.texts, self.highlights = [], [], []
        self.rect(0, 0, W, H, '#f7f9fc')
        self.rect(64, 40, 190, 32, '#eaf0fd', radius=16)
        self.text(80, 45, f'REMOTE CLI / TIP {number:02}', 15, BLUE, True)
        title_size = 43
        while measure(tip['title'], title_size, True) > 1470:
            title_size -= 1
        self.text(64, 92, tip['title'], title_size, bold=True)
        self.block(66, 156, tip['benefit'], 1468, 23, '#646a73', max_lines=2)

    def rect(self, x, y, width, height, fill='white', stroke=None, radius=0, extra=''):
        self.parts.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{fill}"'
                          + (f' stroke="{stroke}" stroke-width="1.4"' if stroke else '') + f' {extra}/>')

    def line(self, x, y, end, color='#dee0e3'):
        self.parts.append(f'<path d="M{x},{y} H{end}" fill="none" stroke="{color}" stroke-width="1.4"/>')

    def text(self, x, y, value, size=22, color='#1f2329', bold=False):
        right = x + measure(value, size, bold)
        assert x >= 0 and y >= 0 and right < W - 25 and y + size * 1.5 <= H, f'Text outside canvas: {self.tip["id"]}'
        if x < 1000 and 224 <= y < 990:
            assert right <= 980 and y + size * 1.4 <= 954, f'Text outside UI crop: {self.tip["id"]}'
        self.texts.append(value)
        self.parts.append(f'<text x="{x}" y="{y + size}" font-size="{size}" fill="{color}" font-weight="{600 if bold else 400}">{html.escape(value)}</text>')

    def wrap(self, value, width, size=22, bold=False, max_lines=None):
        rows = []
        for paragraph in value.split('\n'):
            current = ''
            for char in paragraph:
                if current and measure(current + char, size, bold) > width:
                    rows.append(current.rstrip())
                    current = char.lstrip()
                else:
                    current += char
            rows.append(current)
        if max_lines and len(rows) > max_lines:
            rows = rows[:max_lines]
            while measure(rows[-1] + '…', size, bold) > width:
                rows[-1] = rows[-1][:-1]
            rows[-1] += '…'
        return rows

    def block(self, x, y, value, width, size=22, color='#1f2329', bold=False, max_lines=None):
        for row in self.wrap(value, width, size, bold, max_lines):
            self.text(x, y, row, size, color, bold)
            y += size * 1.55
        return y

    def badge(self, x, y, number):
        self.parts.append(f'<circle cx="{x}" cy="{y}" r="18" fill="{BLUE}"/>')
        self.text(x - measure(str(number), 20, True) / 2, y - 15, str(number), 20, 'white', True)

    def highlight(self, x, y, width, height, number):
        self.highlights.append((x, y, width, height, number))

    def button(self, x, y, label, selected=False, disabled=False, size=20):
        width = measure(label, size) + 32
        self.rect(x, y, width, 47, '#fcfcfd' if disabled else 'white', BLUE if selected else '#d0d2d5', 8)
        self.text(x + 16, y + 9, label, size, '#b6b8bd' if disabled else BLUE if selected else '#1f2329')
        return width

    def user(self, value=None):
        value = value or self.tip['example']
        rows = self.wrap(value, 816, 22, max_lines=3)
        height = len(rows) * 34 + 28
        self.rect(104, 228, 868, height, '#e1ebff', radius=12)
        for index, row in enumerate(rows):
            self.text(128, 240 + index * 34, row, 22, '#1f3864')
        return 228 + height + 22

    def task(self, y, dark=False, directory='/workspace/demo', bottom=954):
        self.dark = dark
        self.ink = '#f0f1f3' if dark else '#1f2329'
        self.muted = '#b5b8bd' if dark else '#646a73'
        self.rule = '#45484d' if dark else '#dee0e3'
        self.rect(64, y, 936, bottom - y, '#292b2f' if dark else 'white', '#45484d' if dark else '#d9dce1', 12)
        self.text(94, y + 20, 'demo', 23, self.ink, True)
        self.rect(190, y + 21, 280, 36, '#202125' if dark else '#f3f4f5', radius=4)
        self.text(201, y + 24, directory, 19, self.ink)
        self.line(94, y + 79, 970, self.rule)
        return y + 100

    def tool(self, y, value):
        self.parts.append(f'<circle cx="102" cy="{y + 18}" r="4" fill="#68b76b"/>')
        self.text(120, y, value, 20, self.muted)
        self.parts.append(f'<path d="M944,{y + 12} l8,8 l8,-8" fill="none" stroke="{self.muted}" stroke-width="2"/>')
        return y + 47

    def robot(self, x, y):
        self.rect(x, y + 8, 23, 18, 'none', '#9256d9', 4)
        self.parts.append(f'<path d="M{x + 11},{y + 8} v-6 M{x - 4},{y + 13} v9 M{x + 27},{y + 13} v9" stroke="#9256d9" stroke-width="2.5"/>')
        for dx in [7, 16]:
            self.parts.append(f'<circle cx="{x + dx}" cy="{y + 17}" r="2" fill="#9256d9"/>')

    def worker(self, y, name, index, result, status='Completed', compact=False, model=None):
        self.line(94, y, 970, self.rule)
        y += 18
        self.robot(98, y)
        self.text(137, y, f'{name} · #{index}', 23, self.ink, True)
        label_width = measure(status, 18) + 20
        self.rect(961 - label_width, y + 2, label_width, 31,
                  '#254530' if self.dark else '#e8f5e6' if status == 'Completed' else '#eaf0fd', radius=5)
        self.text(971 - label_width, y + 4, status, 18, '#76cf7d' if self.dark else '#368544' if status == 'Completed' else BLUE)
        y += 48
        if not compact:
            self.text(98, y, 'Result excerpt' if status == 'Completed' else 'Activity', 17, self.muted)
            y += 33
        y = self.block(98, y, result, 850, 21, self.ink, max_lines=2 if compact else 3)
        if model:
            self.text(98, y + 8, f'Model: {model} · Effort: high (configured)', 16, self.muted)
            y += 42
        return y + 22

    def finish(self):
        for x, y, width, height, number in self.highlights:
            self.rect(x - 6, y - 6, width + 12, height + 12, 'none', '#8faff1', 10, 'stroke-dasharray="5 5"')
            self.badge(x - 14, y - 9, number)
        labels = self.tip['illustration']['labels']
        assert len(labels) == 6
        x = 1054
        prerequisite = self.tip['id'].startswith('delegation-') or self.tip['id'] == 'cross-backend-review'
        self.text(x, 236, UI['delegation'] if prerequisite else UI['command'], 21, '#646a73')
        command = self.tip['example'].split('\n')[0] if self.tip['example'].startswith('/') else '/delegation'
        if len(command) > 25:
            command = command.split(' ')[0]
        command = {'queue-confirm': UI['queue'], 'file-needs-instruction': UI['file'],
                   'image-with-question': UI['image']}.get(self.tip['id'], command)
        self.rect(x, 280, 450, 72, 'white', '#dce2eb', 12)
        self.block(x + 22, 292, command, 406, 25, BLUE, True, max_lines=1)
        for number, top in [(1, 405), (2, 597)]:
            self.badge(x + 18, top + 20, number)
            heading_end = self.block(x + 52, top, labels[(number - 1) * 2], 400, 25, bold=True, max_lines=2)
            self.block(x, max(top + 66, heading_end + 12), labels[(number - 1) * 2 + 1], 450, 23, '#646a73', max_lines=2)
        self.rect(x, 806, 450, 144, '#edf3ff', radius=12)
        self.block(x + 22, 822, labels[4], 407, 24, BLUE, True, max_lines=2)
        self.block(x + 22, 866, labels[5], 407, 20, BLUE, max_lines=2)
        self.line(64, 994, 1536, '#dce2eb')
        self.block(66, 1009, self.tip['illustration']['takeaway'], 1468, 22, '#646a73', max_lines=1)
        self.text(66, 1060, UI['sample'], 18, '#8b919c')
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><title>{html.escape(self.tip["title"])}</title><desc>Source-informed UI reconstruction with synthetic content. No screenshot pixels, real identities, paths, or business records are embedded.</desc><g font-family="Noto Sans CJK SC, sans-serif">' + ''.join(self.parts) + '</g></svg>'
        root = ElementTree.fromstring(svg)
        assert not root.findall('.//{http://www.w3.org/2000/svg}image')
        return svg


def native_panel(canvas, fixture, kind):
    canvas.rect(64, 224, 936, 730, 'white', '#d9dce1', 12)
    canvas.rect(65, 225, 934, 58, '#eaf0ff', radius=11)
    canvas.rect(65, 260, 934, 23, '#eaf0ff')
    canvas.text(94, 236, fixture['header']['title']['content'], 25, BLUE, True)
    cy = 307
    elements = fixture['body']['elements']
    for index, element in enumerate(elements):
        content = element.get('content', '')
        if content.startswith('**3 '):
            break
        if index == 0:
            cy = canvas.block(94, cy, plain(content.split('\n')[0]), 875, 21, bold=True) + 9
        elif element['tag'] == 'hr':
            if index + 1 < len(elements) and elements[index + 1].get('content', '').startswith('**3 '):
                break
            canvas.line(94, cy + 5, 970)
            cy += 27
        elif element['tag'] == 'markdown' and content.startswith('**'):
            group = content.startswith('**Main') or content.startswith('**Other')
            cy = canvas.block(94, cy, plain(content), 876, 19 if group else 22, bold=True) + 13
        elif element['tag'] == 'column_set':
            x = 94
            buttons = [button for column in element['columns'] for button in column['elements']]
            total_width = sum(measure(button['text']['content'], 18) + 32 for button in buttons) + 10 * (len(buttons) - 1)
            assert total_width <= 876, f'Settings row overflows: {kind}'
            for button in buttons:
                label = button['text']['content']
                selected = button['type'] == 'primary'
                bw = canvas.button(x, cy, label, selected, button.get('disabled', False), 18)
                if selected:
                    if kind == 'model' and label.startswith('✓ Codex'):
                        canvas.highlight(x, cy, bw, 47, 1)
                    elif kind == 'model' and 'gpt-' in label:
                        canvas.highlight(x, cy, bw, 47, 2)
                    elif kind == 'backend' and 'Current thread' in label:
                        canvas.highlight(x, cy, bw, 47, 1)
                    elif kind == 'backend' and 'Claude' in label:
                        canvas.highlight(x, cy, bw, 47, 2)
                    elif kind == 'effort' and 'Codex' in label:
                        canvas.highlight(x, cy, bw, 47, 1)
                    elif kind == 'effort' and 'high' in label:
                        canvas.highlight(x, cy, bw, 47, 2)
                x += bw + 10
            cy += 64
    assert cy <= 950, f'Settings card overflows: {kind}'


def delegated_scene(c, variant):
    y = c.task(c.user(), dark=variant in ['delegation-by-instruction', 'delegation-allowance'])
    if variant == 'cross-backend-review':
        y = c.worker(y, 'Codex', 1, 'Input validation updated. Changes integrated before review.', compact=True)
        y = c.worker(y, 'Claude Code', 2, 'Reviewed the integrated changes. One missing edge case found.', compact=True)
        c.block(98, y + 8, 'Review verified; the missing test was added.', 850, 21, c.ink)
    elif variant == 'delegation-independent-checks':
        for index, result in enumerate(['Implementation logic checked.', 'Test coverage checked.', 'Documentation examples checked.'], 1):
            y = c.worker(y, 'Codex', index, result, compact=True)
        c.block(98, y, 'Independent checks collected; findings verified.', 850, 20, c.ink)
    elif variant == 'delegation-parallel-changes':
        y = c.worker(y, 'Codex', 1, 'Update log export in an independent Git worktree.', 'Running')
        y = c.worker(y, 'Claude Code', 2, 'Update configuration validation in another worktree.', 'Running')
        c.block(98, y, 'Integration and verification follow after all workers finish.', 850, 19, c.muted)
    elif variant == 'delegation-by-instruction':
        y = c.block(98, y, 'I will keep coordinating this conversation and ask Codex to check the next change.', 850, 22, c.ink) + 24
        y = c.worker(y, 'Codex', 1, 'Checked test coverage; one boundary case needs a test.', model='gpt-5.2-codex')
        c.text(98, min(y + 18, 915), 'Model: sonnet · Effort: high (configured)', 18, c.muted)
    elif variant == 'delegation-allowance':
        y = c.block(98, y, 'I will assign the next documentation check to Kimi and summarize the result here.', 850, 22, c.ink) + 24
        y = c.worker(y, 'Kimi Code', 1, 'Documentation checked. Two outdated examples found.')
        c.block(98, y + 16, 'No running task was moved; this is a new assignment.', 850, 20, c.muted)
    elif variant == 'delegation-resolve-disagreement':
        y = c.worker(y, 'Codex', 1, 'The empty input appears to be handled.', compact=True)
        y = c.worker(y, 'Claude Code', 2, 'The related test covers spaces, not an empty string.', compact=True)
        y = c.tool(y, 'Bash · Check the disputed input case')
        c.block(98, y + 8, 'Evidence checked: add a separate test for the empty string.', 850, 21, c.ink)


def queue_scene(c):
    y = c.task(c.user())
    c.text(98, y, 'Queue confirmation', 24, bold=True)
    y = c.block(98, y + 49, 'This thread is busy. Add this message to its queue?', 850, 23) + 22
    c.text(98, y, 'Message preview', 19, '#646a73')
    y = c.block(98, y + 39, c.tip['example'], 845, 22, max_lines=3) + 23
    left = c.button(98, y, '✓ Add to queue', selected=True)
    c.button(118 + left, y, 'Cancel')
    c.highlight(98, y, left, 47, 1)
    y += 95
    c.line(98, y, 966)
    c.text(98, y + 25, 'Added to queue for demo.', 23, bold=True)
    c.text(98, y + 70, 'Queue position: 1', 22, '#646a73')
    c.text(98, y + 111, 'Pending messages for this thread: 1', 22, '#646a73')
    c.highlight(92, y + 62, 255, 43, 2)


def command_scene(c, kind):
    request = c.tip['example'].split('\n')[0]
    y = c.task(c.user(request), bottom=690 if kind == 'skills-by-backend' else 954)
    if kind == 'abort-consequences':
        y = c.block(98, y, 'Current command has been aborted', 845, 25, bold=True) + 25
        c.block(98, y, 'Cleared 2 queued messages.', 845, 23)
    elif kind == 'clear-thread-context':
        y = c.block(98, y, 'Conversation context cleared for all direct backends and managed workers in this thread.', 845, 24) + 30
        c.line(98, y, 965)
        c.text(98, y + 30, 'demo · /workspace/demo', 22, '#646a73')
        c.text(98, y + 77, 'Model: sonnet · Effort: high (configured)', 20, '#646a73')
    elif kind == 'compact-backend':
        c.text(98, y, 'Compressing conversation history…', 24, bold=True)
        c.line(98, y + 69, 966)
        c.text(98, y + 100, 'Conversation history compressed', 24)
        c.text(98, y + 158, 'Completed', 20, '#368544')
    elif kind == 'skills-by-backend':
        c.text(98, y, 'Available skills (local discovery):', 24, bold=True)
        c.text(112, y + 62, '• demo-review — Check changes against project rules', 21)
        c.text(112, y + 110, '• demo-docs — Check documentation examples', 21)
        c.rect(104, 736, 868, 145, '#e1ebff', radius=12)
        follow_up = c.tip['example'].split('\n')[-1].replace('\u300c\u5b9e\u9645\u6280\u80fd\u540d\u300d', ' demo-review ')
        c.block(128, 754, follow_up, 816, 23, '#1f3864', max_lines=3)
        c.highlight(93, y + 49, 810, 102, 1)
        c.highlight(104, 736, 868, 145, 2)


def device_scene(c):
    y = c.task(c.user('/device'))
    c.text(98, y, 'Your Devices (2)', 26, bold=True)
    c.text(98, y + 67, '1. demo-laptop', 24, bold=True)
    c.text(127, y + 114, 'Status: Online · ACTIVE', 21, '#368544')
    c.line(98, y + 165, 966)
    c.text(98, y + 191, '2. demo-workstation', 24, bold=True)
    c.text(127, y + 238, 'Status: Online', 21, '#368544')
    c.text(98, y + 308, 'Quick switch: /device <index>', 22, '#646a73')
    c.highlight(92, y + 180, 475, 98, 1)
    c.rect(98, y + 375, 844, 75, '#e1ebff', radius=10)
    c.text(122, y + 392, '/device 2', 27, BLUE, True)
    c.highlight(98, y + 375, 844, 75, 2)


def file_scene(c):
    y = c.task(228)
    c.text(98, y, 'File · parsed', 26, bold=True)
    c.rect(98, y + 60, 842, 171, '#f8f9fb', '#dfe2e7', 9)
    c.text(124, y + 80, 'demo-report.pdf', 26, bold=True)
    c.text(124, y + 131, 'Original saved · Parsed', 22, '#368544')
    c.text(124, y + 177, 'Device: demo-laptop · Thread: demo', 20, '#646a73')
    c.highlight(98, y + 60, 842, 171, 1)
    c.line(98, y + 269, 966)
    c.rect(98, y + 306, 842, 119, '#e1ebff', radius=10)
    c.block(121, y + 324, c.tip['example'].split('\n')[-1], 792, 23, '#1f3864', max_lines=2)
    c.highlight(98, y + 306, 842, 119, 2)
    c.text(98, y + 470, 'Saving a file does not start a model task.', 21, '#646a73')


def image_scene(c):
    c.rect(64, 228, 936, 726, 'white', '#d9dce1', 12)
    c.rect(94, 256, 876, 537, '#e1ebff', radius=12)
    c.rect(120, 280, 823, 309, 'white', '#cad4e5', 8)
    c.rect(120, 280, 823, 46, '#f0f2f5', radius=8)
    c.text(143, 289, 'Demo settings', 21, bold=True)
    c.text(153, 352, 'Display name', 23)
    c.rect(153, 400, 446, 49, 'white', '#d6d9df', 7)
    c.text(170, 410, 'Demo project', 20, '#646a73')
    c.rect(153, 493, 194, 49, '#245bdb', radius=7)
    c.text(174, 502, 'Save changes', 20, 'white')
    c.rect(120, 515, 823, 74, '#f0f2f5', radius=4)
    c.text(143, 536, 'Example: footer overlaps the button', 20, '#646a73')
    c.highlight(120, 280, 823, 309, 1)
    c.block(120, 632, c.tip['example'], 815, 23, '#1f3864', max_lines=3)
    c.highlight(113, 622, 830, 132, 2)
    c.text(98, 832, 'One message · text + image', 22, '#646a73')


def render_svg(tip, number, fixtures):
    c = Canvas(tip, number)
    if tip['id'] in ['model-within-backend', 'backend-current-thread', 'effort-native-options']:
        kind = {'model-within-backend': 'model', 'backend-current-thread': 'backend', 'effort-native-options': 'effort'}[tip['id']]
        native_panel(c, fixtures[kind], kind)
    elif tip['id'].startswith('delegation-') or tip['id'] == 'cross-backend-review':
        delegated_scene(c, tip['id'])
    elif tip['id'] == 'queue-confirm':
        queue_scene(c)
    elif tip['id'] == 'device-selection':
        device_scene(c)
    elif tip['id'] == 'file-needs-instruction':
        file_scene(c)
    elif tip['id'] == 'image-with-question':
        image_scene(c)
    else:
        command_scene(c, tip['id'])
    return c.finish()


def render_png(svg, png):
    rsvg = ctypes.CDLL(ctypes.util.find_library('rsvg-2'))
    cairo = ctypes.CDLL(ctypes.util.find_library('cairo'))
    gobject = ctypes.CDLL(ctypes.util.find_library('gobject-2.0'))
    rsvg.rsvg_handle_new_from_data.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    rsvg.rsvg_handle_new_from_data.restype = ctypes.c_void_p
    rsvg.rsvg_handle_render_cairo.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    rsvg.rsvg_handle_render_cairo.restype = ctypes.c_int
    cairo.cairo_image_surface_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    cairo.cairo_image_surface_create.restype = ctypes.c_void_p
    cairo.cairo_create.argtypes = [ctypes.c_void_p]
    cairo.cairo_create.restype = ctypes.c_void_p
    cairo.cairo_surface_write_to_png.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    cairo.cairo_surface_write_to_png.restype = ctypes.c_int
    cairo.cairo_destroy.argtypes = [ctypes.c_void_p]
    cairo.cairo_surface_destroy.argtypes = [ctypes.c_void_p]
    gobject.g_object_unref.argtypes = [ctypes.c_void_p]
    data = svg.read_bytes()
    handle = rsvg.rsvg_handle_new_from_data(data, len(data), None)
    assert handle, 'SVG parse failed'
    surface = cairo.cairo_image_surface_create(0, W, H)
    context = cairo.cairo_create(surface)
    try:
        assert rsvg.rsvg_handle_render_cairo(handle, context), 'SVG render failed'
        assert cairo.cairo_surface_write_to_png(surface, str(png).encode()) == 0
    finally:
        cairo.cairo_destroy(context)
        cairo.cairo_surface_destroy(surface)
        gobject.g_object_unref(handle)
    with Image.open(png) as image:
        image.convert('RGB').quantize(colors=192, method=Image.Quantize.MEDIANCUT).save(png, optimize=True)
    assert 3072 < png.stat().st_size <= 192 * 1024, f'PNG exceeds package budget: {png.name}'
    with Image.open(png) as image:
        assert image.size == (W, H) and not image.info
        image.verify()


def gallery(catalog, portable=False):
    cards = []
    for number, tip in enumerate(catalog, 1):
        png = f'png/{tip["image"]}' if portable else f'../packages/router/src/tips/assets/{tip["image"]}'
        svg = f'svg/{tip["id"]}.svg' if portable else f'tips/svg/{tip["id"]}.svg'
        cards.append(f'<article id="{tip["id"]}"><a href="{png}"><img src="{png}" alt="{html.escape(tip["title"], quote=True)}" loading="lazy"></a><div class="copy"><h2>{number:02} · {html.escape(tip["title"])}</h2><p>{html.escape(tip["benefit"])}</p><h3>{UI["usage"]}</h3><p>{html.escape(tip["action"])}</p><pre>{html.escape(tip["example"])}</pre><details><summary>{UI["detail"]}</summary><p>{html.escape(tip["detail"])}</p></details><p><a href="{png}" download>{UI["png"]}</a> · <a href="{svg}" download>{UI["svg"]}</a></p></div></article>')
    links = '' if portable else f'<p><a href="tips/remote-cli-tips.zip">{UI["bundle"]}</a> · <a href="tips/contact-sheet.png">{UI["overview"]}</a></p>'
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + UI['galleryTitle'] + '</title><style>body{margin:0;background:#f5f7fb;color:#202631;font:16px/1.65 system-ui,sans-serif}header{max-width:1440px;margin:40px auto 26px;padding:0 24px}h1{font-size:32px}a{color:#245bdb}main{max-width:1440px;margin:auto;padding:0 24px 48px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{background:white;border:1px solid #dce2eb;border-radius:14px;overflow:hidden}img{display:block;width:100%;height:auto}.copy{padding:8px 24px 20px}h2{font-size:21px}h3{font-size:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7fb;padding:14px;border-radius:8px}details{color:#606a79}@media(max-width:850px){main{grid-template-columns:1fr}header{margin-top:22px}}</style><header><h1>' + UI['galleryTitle'] + '</h1><p>' + UI['galleryIntro'] + '</p>' + links + '</header><main>' + ''.join(cards) + '</main></html>'


def main():
    catalog = json.loads((SOURCE / 'catalog.zh-CN.json').read_text())
    assert len(catalog) == 17, 'Expected the approved 17-topic catalog'
    fixtures = settings_fixtures()
    svg_directory = DOCS / 'svg'
    svg_directory.mkdir(parents=True, exist_ok=True)
    assets = SOURCE / 'assets'
    assets.mkdir(exist_ok=True)
    hashes = set()
    for number, tip in enumerate(catalog, 1):
        svg = svg_directory / f'{tip["id"]}.svg'
        png = assets / tip['image']
        svg.write_text(render_svg(tip, number, fixtures))
        render_png(svg, png)
        digest = hashlib.sha256(png.read_bytes()).hexdigest()
        assert digest not in hashes, 'Duplicate illustration'
        hashes.add(digest)
        print(f'{number:02} {tip["id"]}: {png.stat().st_size} bytes', flush=True)
    # Remove only obsolete generated PNGs/SVGs, never other source files.
    expected_png = {tip['image'] for tip in catalog}
    expected_svg = {f'{tip["id"]}.svg' for tip in catalog}
    for directory, suffix, expected in [(assets, '*.png', expected_png), (svg_directory, '*.svg', expected_svg)]:
        for file in directory.glob(suffix):
            if file.name not in expected:
                file.unlink()
    (ROOT / 'docs/tips-preview.html').write_text(gallery(catalog))
    sheet = Image.new('RGB', (1600, 6 * 382 + 24), '#edf1f7')
    for index, tip in enumerate(catalog):
        with Image.open(assets / tip['image']) as image:
            thumbnail = image.convert('RGB').resize((510, 357), Image.Resampling.LANCZOS)
            sheet.paste(thumbnail, (20 + index % 3 * 530, 16 + index // 3 * 382))
    sheet.quantize(colors=192).save(DOCS / 'contact-sheet.png', optimize=True)
    with zipfile.ZipFile(DOCS / 'remote-cli-tips.zip', 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr('remote-cli-tips/index.html', gallery(catalog, portable=True))
        bundle.writestr('remote-cli-tips/catalog.zh-CN.json', json.dumps(catalog, ensure_ascii=False, indent=2))
        for tip in catalog:
            bundle.write(assets / tip['image'], f'remote-cli-tips/png/{tip["image"]}')
            bundle.write(svg_directory / f'{tip["id"]}.svg', f'remote-cli-tips/svg/{tip["id"]}.svg')
    print(f'Generated {len(catalog)} PNGs, {len(catalog)} SVGs, gallery, contact sheet and archive.')


if __name__ == '__main__':
    main()
