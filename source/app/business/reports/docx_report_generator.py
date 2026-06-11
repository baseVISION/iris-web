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
from typing import Dict, List

from docxtpl import DocxTemplate
from jinja2 import Environment
from lxml import etree

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
    """Renderer that emits markdown images as inline drawing runs."""

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
