#  IRIS Source Code
#  Copyright (C) 2026 baseVISION
#
#  This program is free software; you can redistribute it and/or
#  modify it under the terms of the GNU Lesser General Public License
#  as published by the Free Software Foundation; either version 3 of
#  the License, or (at your option) any later version.

import logging
import os
import re
import zipfile
from functools import lru_cache
from typing import Dict, List

from docxtpl import DocxTemplate
from jinja2 import Environment
from lxml import etree

from pygments import lex
from pygments.lexers import get_lexer_by_name, guess_lexer
from pygments.styles import get_style_by_name
from pygments.token import Text, Whitespace
from pygments.util import ClassNotFound

from docx_generator.adapters.docx.docx_adapter import make_paragraph, make_run
from docx_generator.adapters.docx.style_adapter import get_document_render_styles
from docx_generator.adapters.mistletoe.DocxRenderer import DocxRenderer
from docx_generator.docx_generator import DocxGenerator
from docx_generator.exceptions.rendering_error import RenderingError


PARAGRAPH_RE = re.compile(r'<w:p(?:\s[^>]*)?>.*?</w:p>', re.DOTALL)
TEXT_RE = re.compile(r'<w:t(?:\s[^>]*)?>(.*?)</w:t>', re.DOTALL)
JINJA_VAR_RE = re.compile(r'^\s*({{(?P<expr>.*?)}})\s*$', re.DOTALL)
MARKDOWN_FILTER_RE = re.compile(r'\|\s*markdown(?:\s*\([^{}]*\))?(?=\s*(?:\||$))', re.DOTALL)
DRAWING_RE = re.compile(r'<w:drawing(?:\s[^>]*)?>.*?</w:drawing>', re.DOTALL)

WORD_TEXT_NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
WORD_XML_PART_RE = re.compile(r'^word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$')

_W_NS = WORD_TEXT_NS['w']
_W = '{%s}' % _W_NS

# Schema order of children inside <w:rPr> (CT_RPr). Word usually tolerates loose order,
# but inserting <w:color> deterministically avoids validator surprises.
_RPR_ORDER = [
    'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps',
    'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint',
    'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing',
    'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect',
    'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang',
    'eastAsianLayout', 'specVanish', 'oMath',
]
_COLOR_POS = _RPR_ORDER.index('color')

# Above this size, skip syntax highlighting (run explosion / perf) and render plain.
_MAX_CODE_HIGHLIGHT_CHARS = 50000

# Markdown tables: the base renderer emits tblW=auto + a single grid column, so Word shrinks
# the table to its content (compressed). We render them 100% wide with a fixed layout and one
# equal grid column per markdown column. Explicit borders (matching the ReportMain look) ensure
# the boxes show whether cells are populated or not, on any template.
_TABLE_TOTAL_WIDTH_TWIPS = 9638  # ~full text width (Letter, 1in margins)
_TABLE_BORDERS = (
    '<w:tblBorders>'
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="7F7F7F" w:themeColor="text1" w:themeTint="80"/>'
    '</w:tblBorders>'
)


@lru_cache(maxsize=1)
def _pygments_style():
    # 'default' is always available and readable on a white Word page.
    return get_style_by_name('xcode')


@lru_cache(maxsize=512)
def _token_color(ttype):
    # Plain text / whitespace inherit the code paragraph's default (grey); only "interesting"
    # tokens (keywords, strings, comments, ...) get an explicit colour.
    if ttype in Text or ttype in Whitespace:
        return None
    color = _pygments_style().style_for_token(ttype).get('color')
    return color.upper() if color else None


def _rpr_sort_index(element):
    try:
        return _RPR_ORDER.index(etree.QName(element).localname)
    except ValueError:
        return len(_RPR_ORDER)


def _rpr_with_color(base_rpr, color):
    """Return a <w:rPr> string based on base_rpr (the monospace inline-code run props) with
    any existing <w:color> removed and `color` (RRGGBB or None) inserted in schema-safe order."""
    xml = (base_rpr or '').strip()
    if not xml:
        xml = '<w:rPr/>'
    elif '<w:rPr' not in xml:
        xml = '<w:rPr>{}</w:rPr>'.format(xml)

    wrapper = etree.fromstring('<root xmlns:w="{}">{}</root>'.format(_W_NS, xml).encode('utf-8'))
    rpr = wrapper.find(_W + 'rPr')
    if rpr is None:
        rpr = etree.SubElement(wrapper, _W + 'rPr')

    for child in list(rpr):
        if etree.QName(child).localname == 'color':
            rpr.remove(child)

    if color:
        color_el = etree.Element(_W + 'color')
        color_el.set(_W + 'val', color)
        insert_at = len(rpr)
        for idx, child in enumerate(rpr):
            if _rpr_sort_index(child) > _COLOR_POS:
                insert_at = idx
                break
        rpr.insert(insert_at, color_el)

    return etree.tostring(rpr, encoding='unicode', with_tail=False)


def _code_text(token):
    if getattr(token, 'children', None):
        return token.children[0].content
    return getattr(token, 'content', '')


def _lexer_for_code(language, code):
    if language:
        try:
            return get_lexer_by_name(language, stripnl=False, ensurenl=False)
        except ClassNotFound:
            return None
    # Only guess for reasonably small unlabelled blocks (guessing is slow and error-prone).
    if code and len(code) <= 20000:
        try:
            return guess_lexer(code, stripnl=False, ensurenl=False)
        except ClassNotFound:
            return None
    return None


class MarkdownAwareDocxTemplate(DocxTemplate):
    """DocxTemplate that promotes whole-paragraph markdown placeholders.

    docx_generator's markdown filter returns block-level WordprocessingML. Standard docxtpl
    rendering leaves inline ``{{ field|markdown }}`` placeholders inside ``<w:t>`` text nodes,
    which makes Word reject the document. When the markdown placeholder is the full paragraph
    content, render it outside the surrounding paragraph so block OOXML is inserted at a legal
    block boundary.
    """

    def build_xml(self, context, jinja_env=None):
        xml = self.get_xml()
        xml = self.patch_xml(xml)
        xml = _promote_markdown_paragraphs(xml)
        xml = self.render_xml_part(xml, self.docx._part, context, jinja_env)
        return xml


class MarkdownImageDocxRenderer(DocxRenderer):
    """Renderer that emits markdown images as inline drawing runs and syntax-highlights code."""

    def render_block_code(self, token):
        """Syntax-highlight fenced code blocks: lex with Pygments and emit one coloured run
        per token (adjacent same-colour tokens merged). Falls back to the default single
        grey run when there is no usable lexer or no colour was produced. Output stays
        Word-valid (text-only <w:t> leaves)."""
        code = _code_text(token).replace('\r\n', '\n').replace('\r', '\n')
        if code.endswith('\n'):
            code = code[:-1]   # drop the fence's trailing newline -> no spurious blank line
        code = code.expandtabs(4)   # make_run has no <w:tab/>; spaces keep indentation

        if len(code) > _MAX_CODE_HIGHLIGHT_CHARS:
            return super().render_block_code(token)

        lexer = _lexer_for_code(getattr(token, 'language', None), code)
        if lexer is None:
            return super().render_block_code(token)

        runs = []
        rpr_by_color = {}
        has_explicit_color = False
        last_color = object()   # sentinel distinct from any real colour / None
        pending = []

        def rpr_for(color):
            if color not in rpr_by_color:
                rpr_by_color[color] = _rpr_with_color(self.style.inline_code, color)
            return rpr_by_color[color]

        def flush():
            if pending:
                runs.append(make_run(rpr_for(last_color), ''.join(pending)))
                pending.clear()

        for ttype, value in lex(code, lexer):
            if not value:
                continue
            color = _token_color(ttype)
            has_explicit_color = has_explicit_color or bool(color)
            if color != last_color:
                flush()
                last_color = color
            pending.append(value)
        flush()

        if not runs or not has_explicit_color:
            return super().render_block_code(token)

        return make_paragraph(self.style.code, ''.join(runs))

    def render_table(self, token):
        """Render a markdown table spanning the full page width with equal columns.

        The base renderer leaves the table at tblW=auto (Word shrinks it to its content, so it
        looks compressed) with a single grid column. Here we emit a 100%-wide, fixed-layout
        table with one equal grid column per markdown column, keeping the ReportMain style and
        explicit borders so the table renders evenly regardless of how full the cells are.
        """
        ncols = len(getattr(token, 'column_align', None) or [])
        header_tok = getattr(token, 'header', None)
        if not ncols and header_tok is not None:
            ncols = len(getattr(header_tok, 'children', None) or [])
        if ncols < 1:
            ncols = 1

        header = self.render(header_tok) if header_tok is not None else ''
        content = self.render_inner(token)

        col_w = max(1, _TABLE_TOTAL_WIDTH_TWIPS // ncols)
        grid = ''.join('<w:gridCol w:w="{}"/>'.format(col_w) for _ in range(ncols))
        tbl_pr = (
            '<w:tblPr>'
            '<w:tblStyle w:val="ReportMain"/>'
            '<w:tblW w:type="pct" w:w="5000"/>'
            + _TABLE_BORDERS +
            '<w:tblLayout w:type="fixed"/>'
            '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>'
            '</w:tblPr>'
        )
        return '<w:tbl>{}<w:tblGrid>{}</w:tblGrid>{}{}</w:tbl>'.format(tbl_pr, grid, header, content)

    def render_image(self, token):
        if self._image_handler is None:
            return ''

        self._image_handler.set_template(self._template)
        image = self._image_handler.add_picture(token.src)
        if image is None:
            return ''

        drawings = DRAWING_RE.findall(str(image))
        if not drawings:
            return ''

        return '<w:r>{}</w:r>'.format(''.join(drawings))


class IrisDocxGenerator(DocxGenerator):
    """Fork-local DOCX generator with valid markdown block insertion."""

    def _recursive_rendering(self, base_path: str, template_path: str, data: Dict, output_path: str, render_level: int):
        render_level += 1
        self._logger.info('Start rendering for level {}'.format(render_level))

        loaded_template = MarkdownAwareDocxTemplate(template_path)
        template_styles = get_document_render_styles(template_path)
        docx_renderer = MarkdownImageDocxRenderer(loaded_template, self._image_handler)

        jinja_custom_environment = Environment()

        self._set_jinja2_custom_environment(base_path, loaded_template, jinja_custom_environment, docx_renderer, template_styles)

        try:
            loaded_template.render(data, jinja_env=jinja_custom_environment, autoescape=True)
        except RenderingError as e:
            raise e
        except Exception as e:
            error_message = '{} ({})'.format(str(e), os.path.basename(template_path))
            raise RenderingError(self._logger, error_message)

        is_variable_found = False
        variable_regex = "{{.+}}|{%.+%}"

        for paragraph in loaded_template.paragraphs:
            if re.search(variable_regex, paragraph.text) is not None:
                is_variable_found = True
                break

        for table in loaded_template.tables:
            for row in table.rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        if re.search(variable_regex, paragraph.text) is not None:
                            is_variable_found = True
                            break

        loaded_template.save(output_path)
        self._logger.info('Document generated for level {}'.format(render_level))

        if is_variable_found and render_level <= self._max_recursive_render_depth:
            self._logger.info('Variable found in generated document. Restarting rendering process ...')
            self._recursive_rendering('', output_path, data, output_path, render_level)

        if render_level > self._max_recursive_render_depth:
            self._logger.info('Rendering depth level exceeded, leaving render loop')

        self._logger.info('Rendering process completed !')


def _promote_markdown_paragraphs(xml: str) -> str:
    def replace(match):
        paragraph = match.group(0)
        text = ''.join(TEXT_RE.findall(paragraph))
        jinja_var = JINJA_VAR_RE.match(text)
        if not jinja_var:
            return paragraph
        if MARKDOWN_FILTER_RE.search(jinja_var.group('expr')) is None:
            return paragraph
        return jinja_var.group(1)

    return PARAGRAPH_RE.sub(replace, xml)


def find_docx_text_leaf_violations(docx_path: str) -> List[str]:
    violations = []
    with zipfile.ZipFile(docx_path) as archive:
        for part in archive.namelist():
            if WORD_XML_PART_RE.match(part) is None:
                continue

            root = etree.fromstring(archive.read(part))
            for text_node in root.xpath('.//w:t', namespaces=WORD_TEXT_NS):
                if len(text_node):
                    violations.append('{} contains <w:t> with {} child element(s)'.format(part, len(text_node)))

    return violations


def validate_docx_text_leaf_nodes(docx_path: str) -> None:
    violations = find_docx_text_leaf_violations(docx_path)
    if violations:
        raise RenderingError(
            logging.getLogger(__name__),
            'Generated DOCX is not Word-valid: {}'.format('; '.join(violations[:10]))
        )
