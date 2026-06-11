#  IRIS Source Code
#  Copyright (C) 2021 - Airbus CyberSecurity (SAS)
#  ir@cyberactionlab.net
#
#  This program is free software; you can redistribute it and/or
#  modify it under the terms of the GNU Lesser General Public
#  License as published by the Free Software Foundation; either
#  version 3 of the License, or (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
#  Lesser General Public License for more details.
#
#  You should have received a copy of the GNU Lesser General Public License
#  along with this program; if not, write to the Free Software Foundation,
#  Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
import datetime
import re

from sqlalchemy import desc

from app.datamgmt.case.case_notes_db import get_notes_from_group
from app.datamgmt.case.case_notes_db import get_case_note_comments
from app.models.assets import CompromiseStatus, AssetsType, CaseAssets, AnalysisStatus
from app.models.models import TaskAssignee
from app.models.models import CaseEventsAssets
from app.models.models import CaseEventsIoc
from app.models.evidences import CaseReceivedFile
from app.models.models import CaseTasks
from app.models.cases import Cases
from app.models.cases import CasesEvent
from app.models.comments import Comments
from app.models.models import EventCategory
from app.models.iocs import Ioc
from app.models.models import IocAssetLink
from app.models.models import IocType
from app.models.models import Notes
from app.models.models import NotesGroup
from app.models.models import TaskStatus
from app.models.iocs import Tlp
from app.models.authorization import User
from app.schema.marshables import CaseDetailsSchema
from app.schema.marshables import CommentSchema
from app.schema.marshables import CaseNoteSchema


def export_case_json_extended(case_id):
    """
    Export a case a JSON
    """
    export = {}
    case = export_caseinfo_json_extended(case_id)

    if not case:
        export['errors'] = ["Invalid case number"]
        return export

    export['case'] = case
    export['evidences'] = export_case_evidences_json_extended(case_id)
    export['timeline'] = export_case_tm_json_extended(case_id)
    export['iocs'] = export_case_iocs_json_extended(case_id)
    export['assets'] = export_case_assets_json_extended(case_id)
    export['tasks'] = export_case_tasks_json_extended(case_id)
    export['notes'] = export_case_notes_json_extended(case_id)
    export['export_date'] = datetime.datetime.utcnow()

    return export


def _docx_width_percent(size_token):
    """Extract a width percentage (1..100) from an IRIS image size token.

    Accepts the width part of tokens like '50%x*', '100%x40%', '50.5%'. Returns None for
    pixel sizes, '*', or anything that is not a percentage (image then embeds at native size).
    """
    if not size_token:
        return None
    width = re.split(r'[xX]', size_token, maxsplit=1)[0].strip()
    match = re.fullmatch(r'(\d+(?:\.\d+)?)%', width)
    if not match:
        return None
    return max(1, min(100, round(float(match.group(1)))))


# A markdown image whose destination is a datastore link, with optional ' =SIZE' suffix and
# optional title: ![alt](/datastore/file/view/ID?cid=CID[&...] [=W%x*] ["title"|'title'])
_DOCX_DATASTORE_IMAGE = re.compile(
    r'!\[(?P<alt>[^\]]*)\]\(\s*'
    r'(?P<url>/datastore/file/view/\d+\?cid=\d+[^\s)"\']*)'
    r'(?:\s+=(?P<size>[^\s)"\']+))?'
    r'(?:\s+(?P<title>"[^"]*"|\'[^\']*\'))?'
    r'\s*\)'
)


def _docx_rewrite_datastore_image(match):
    """Absolutize a datastore image URL and carry its width as an &iriswidth= query param.

    ImageHandler resolves the file locally (the host is irrelevant) and reads iriswidth to
    scale the embedded picture. cid stays first so ImageHandler's regex still matches.
    """
    url = 'http://127.0.0.1:8000' + match.group('url')
    pct = _docx_width_percent(match.group('size'))
    if pct is not None:
        url += '&iriswidth={}'.format(pct)
    title = match.group('title')
    title_part = ' {}'.format(title) if title else ''
    return '![{}]({}{})'.format(match.group('alt'), url, title_part)


_FENCE_OPEN = re.compile(r'(`{3,}|~{3,})')

# Milkdown/Crepe serializes empty paragraphs and soft breaks as literal <br /> HTML. mistletoe
# (the DOCX renderer) does not parse inline HTML, so a <br> would be emitted as literal "<br />"
# text in the Word document. Convert it to a real newline so it renders as a line break (and
# standalone <br> "blank line" paragraphs collapse) — only outside fenced code blocks.
_HTML_BR = re.compile(r'<br\s*/?>', re.IGNORECASE)


def _fence_run(line):
    """Return the fence delimiter run (e.g. '```', '~~~~') if `line` is a CommonMark fenced-code
    delimiter, else None. Rules enforced: at most 3 leading spaces (4+ is indented code, not a
    fence), and a backtick fence's info string may not contain a backtick (so '```code```' on one
    line is inline code/text, not a fence opener)."""
    stripped = line.lstrip(' ')
    if len(line) - len(stripped) > 3:
        return None
    m = _FENCE_OPEN.match(stripped)
    if not m:
        return None
    run = m.group(1)
    rest = stripped[len(run):]
    if run[0] == '`' and '`' in rest:
        return None
    return run


def _process_md_images_for_docx(markdown_text):
    """DOCX-only image preprocessing, applied only OUTSIDE fenced code blocks so literal
    image examples inside ``` / ~~~ fences are left untouched.

    Deterministic O(n) line scanner (no catastrophic backtracking). Datastore image syntax is
    always single-line, so non-code lines are transformed individually. A code block opened by
    N backticks/tildes is closed only by a line of >=N of the SAME char with nothing else after
    it (CommonMark); an unterminated fence keeps everything to EOF as code.
    """
    if not markdown_text:
        return markdown_text

    out = []
    fence_char = None
    fence_len = 0
    for line in markdown_text.split('\n'):
        run = _fence_run(line)
        if fence_char is None:
            if run:
                fence_char = run[0]
                fence_len = len(run)
                out.append(line)            # opening fence, untouched
            else:
                line = _DOCX_DATASTORE_IMAGE.sub(_docx_rewrite_datastore_image, line)
                line = _HTML_BR.sub('\n', line)
                out.append(line)
        else:
            out.append(line)                # inside a code block, untouched
            # close: same char, length >= opener, only whitespace after the run
            if run and run[0] == fence_char and len(run) >= fence_len:
                if line.lstrip(' ')[len(run):].strip() == '':
                    fence_char = None
                    fence_len = 0
    return '\n'.join(out)


def process_md_images_links_for_report(markdown_text, for_docx=False):
    """Process image links in markdown for the report generator.

    for_docx=False (default): legacy behavior, kept byte-for-byte for the REST API and
    Markdown exports (absolutizes only sized datastore links and strips the size).

    for_docx=True: DOCX export — absolutize ALL datastore links (an unsized relative link
    otherwise fails report generation) and carry the width as &iriswidth= for ImageHandler.
    """
    if not for_docx:
        markdown = re.sub(r'(/datastore\/file\/view\/\d+\?cid=\d+)( =[\dA-z%]*)\)',
                          r"http://127.0.0.1:8000:/\1)", markdown_text)
        return markdown

    return _process_md_images_for_docx(markdown_text)


def export_caseinfo_json_extended(case_id):
    case = Cases.query.filter(
        Cases.case_id == case_id
    ).first()

    return case


def export_case_evidences_json_extended(case_id):
    evidences = CaseReceivedFile.query.filter(
        CaseReceivedFile.case_id == case_id
    ).join(
        CaseReceivedFile.case
    ).join(
        CaseReceivedFile.user).all()

    return evidences


def export_case_tm_json_extended(case_id):
    events = CasesEvent.query.filter(
        CasesEvent.case_id == case_id
    ).all()

    return events


def export_case_iocs_json_extended(case_id):
    iocs = Ioc.query.filter(
        Ioc.case_id == case_id
    ).all()

    return iocs


def export_case_assets_json_extended(case_id):
    assets = CaseAssets.query.filter(
        CaseAssets.case_id == case_id
    ).all()

    return assets


def export_case_tasks_json_extended(case_id):
    tasks = CaseTasks.query.filter(
        CaseTasks.task_case_id == case_id
    ).all()

    return tasks


def export_case_notes_json_extended(case_id):
    notes_groups = NotesGroup.query.filter(
        NotesGroup.group_case_id == case_id
    ).all()

    for notes_group in notes_groups:
        notes_group = notes_group.__dict__
        notes_group['notes'] = get_notes_from_group(notes_group['group_id'], case_id)

    return notes_groups


def export_caseinfo_json(case_id):

    case = Cases.query.filter(
        Cases.case_id == case_id
    ).first()

    if not case:
        return None

    case = CaseDetailsSchema().dump(case)

    return case


def export_case_evidences_json(case_id):
    evidences = CaseReceivedFile.query.filter(
        CaseReceivedFile.case_id == case_id
    ).with_entities(
        CaseReceivedFile.filename,
        CaseReceivedFile.date_added,
        CaseReceivedFile.file_hash,
        User.name.label('added_by'),
        CaseReceivedFile.custom_attributes,
        CaseReceivedFile.file_uuid,
        CaseReceivedFile.id,
        CaseReceivedFile.file_size,
    ).order_by(
        CaseReceivedFile.date_added
    ).join(
        CaseReceivedFile.user
    ).all()

    if evidences:

        return [row._asdict() for row in evidences]

    return []


def export_case_notes_json(case_id, for_docx=False):
    # Fetch all notes associated with the case
    notes = Notes.query.filter(
        Notes.note_case_id == case_id
    ).all()

    # Initialize the schemas
    note_schema = CaseNoteSchema()
    comments_schema = CommentSchema(many=True)

    # Serialize the notes and their comments
    serialized_notes = []
    for note in notes:
        note_comments = get_case_note_comments(note.note_id)
        serialized_note = note_schema.dump(note)
        serialized_note['comments'] = comments_schema.dump(note_comments)
        serialized_note['note_content'] = process_md_images_links_for_report(serialized_note['note_content'], for_docx=for_docx)

        serialized_notes.append(serialized_note)

    return serialized_notes


def export_case_tm_json(case_id):
    timeline = CasesEvent.query.with_entities(
        CasesEvent.event_id,
        CasesEvent.event_title,
        CasesEvent.event_in_summary,
        CasesEvent.event_date,
        CasesEvent.event_tz,
        CasesEvent.event_date_wtz,
        CasesEvent.event_content,
        CasesEvent.event_tags,
        CasesEvent.event_source,
        CasesEvent.event_raw,
        CasesEvent.custom_attributes,
        EventCategory.name.label('category'),
        User.name.label('last_edited_by'),
        CasesEvent.event_uuid,
        CasesEvent.event_in_graph,
        CasesEvent.event_in_summary,
        CasesEvent.event_color,
        CasesEvent.event_is_flagged
    ).filter(
        CasesEvent.case_id == case_id
    ).order_by(
        CasesEvent.event_date
    ).join(
        CasesEvent.user
    ).outerjoin(
        CasesEvent.category
    ).all()

    tim = []
    for row in timeline:
        ras = row._asdict()
        ras['assets'] = None

        as_list = CaseEventsAssets.query.with_entities(
            CaseAssets.asset_id,
            CaseAssets.asset_name,
            AssetsType.asset_name.label('type')
        ).filter(
            CaseEventsAssets.event_id == row.event_id
        ).join(
            CaseEventsAssets.asset
        ).join(
            CaseAssets.asset_type
        ).all()

        alki = []
        for asset in as_list:
            alki.append(f'{asset.asset_name} ({asset.type})')

        ras['assets'] = alki

        iocs_list = CaseEventsIoc.query.with_entities(
            CaseEventsIoc.ioc_id,
            Ioc.ioc_value,
            Ioc.ioc_description,
            Tlp.tlp_name,
            IocType.type_name.label('type')
        ).filter(
            CaseEventsIoc.event_id == row.event_id
        ).join(
            CaseEventsIoc.ioc
        ).join(
            Ioc.ioc_type
        ).join(
            Ioc.tlp
        ).all()

        ras['iocs'] = [ioc._asdict() for ioc in iocs_list]

        tim.append(ras)

    return tim


def export_case_tasks_json(case_id):
    res = CaseTasks.query.with_entities(
        CaseTasks.task_title,
        TaskStatus.status_name.label('task_status'),
        CaseTasks.task_tags,
        CaseTasks.task_open_date,
        CaseTasks.task_close_date,
        CaseTasks.task_last_update,
        CaseTasks.task_description,
        CaseTasks.custom_attributes,
        CaseTasks.task_uuid,
        CaseTasks.id
    ).filter(
        CaseTasks.task_case_id == case_id
    ).join(
       CaseTasks.status
    ).all()

    tasks = [c._asdict() for c in res]

    task_with_assignees = []
    for task in tasks:
        task_id = task['id']
        get_assignee_list = TaskAssignee.query.with_entities(
            TaskAssignee.task_id,
            User.user,
            User.id,
            User.name
        ).join(
            TaskAssignee.user
        ).filter(
            TaskAssignee.task_id == task_id
        ).all()

        assignee_list = {}
        for member in get_assignee_list:
            if member.task_id not in assignee_list:

                assignee_list[member.task_id] = [{
                    'user': member.user,
                    'name': member.name,
                    'id': member.id
                }]
            else:
                assignee_list[member.task_id].append({
                    'user': member.user,
                    'name': member.name,
                    'id': member.id
                })
        task['task_assignees'] = assignee_list.get(task['id'], [])
        task_with_assignees.append(task)

    return task_with_assignees


def export_case_assets_json(case_id):
    ret = []

    res = CaseAssets.query.with_entities(
        CaseAssets.asset_id,
        CaseAssets.asset_uuid,
        CaseAssets.asset_name,
        CaseAssets.asset_description,
        CaseAssets.asset_compromise_status_id,
        AssetsType.asset_name.label("type"),
        AnalysisStatus.name.label('analysis_status'),
        CaseAssets.date_added,
        CaseAssets.asset_domain,
        CaseAssets.asset_ip,
        CaseAssets.asset_info,
        CaseAssets.asset_tags,
        CaseAssets.custom_attributes
    ).filter(
        CaseAssets.case_id == case_id
    ).join(
        CaseAssets.asset_type
    ).join(
        CaseAssets.analysis_status
    ).order_by(desc(CaseAssets.asset_compromise_status_id)).all()

    for row in res:
        row = row._asdict()
        row['light_asset_description'] = row['asset_description']

        ial = IocAssetLink.query.with_entities(
            Ioc.ioc_value,
            IocType.type_name,
            Ioc.ioc_description
        ).filter(
            IocAssetLink.asset_id == row['asset_id']
        ).join(
            IocAssetLink.ioc
        ).join(
            Ioc.ioc_type
        ).all()

        if ial:
            row['asset_ioc'] = [row._asdict() for row in ial]
        else:
            row['asset_ioc'] = []

        if row['asset_compromise_status_id'] is None:
            row['asset_compromise_status_id'] = CompromiseStatus.unknown.value
            status_text = CompromiseStatus.unknown.name.replace('_', ' ').title()
        else:
            status_text = CompromiseStatus(row['asset_compromise_status_id']).name.replace('_', ' ').title()

        row['asset_compromise_status'] = status_text

        ret.append(row)

    return ret


def export_case_comments_json(case_id):
    comments = Comments.query.with_entities(
        Comments.comment_id,
        Comments.comment_uuid,
        Comments.comment_text,
        User.name.label('comment_by'),
        Comments.comment_date,
    ).filter(
        Comments.comment_case_id == case_id
    ).join(
        Comments.user
    ).order_by(
        Comments.comment_date
    ).all()

    return [row._asdict() for row in comments]
